// Shared GLSL for the ocean spectrum / FFT simulation (WebGL2 fragment path).
// Math follows Horvath 2015 "Empirical directional wave spectra for computer graphics"
// (JONSWAP + TMA shallow-water correction, Hasselmann / Donelan-Banner directional spreading)
// as popularised by the gasgiant / Jump Trajectory FFT ocean and the Sea of Thieves talk.

export const SIM_MATH_GLSL = /* glsl */`
#define PI 3.14159265358979
#define TWO_PI 6.28318530717959

// ---- integer hash -> uniform floats (pcg3d, Jarzynski & Olano 2020) ----
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
vec3 hash3(uvec3 p) {
    return vec3(pcg3d(p)) * (1.0 / 4294967296.0);
}
// two independent standard normal variates (Box-Muller)
vec2 gaussian2(uvec2 texel, uint seed) {
    vec3 r = hash3(uvec3(texel, seed));
    float u1 = max(r.x, 1e-7);
    float u2 = r.y;
    float mag = sqrt(-2.0 * log(u1));
    return vec2(mag * cos(TWO_PI * u2), mag * sin(TWO_PI * u2));
}

// ---- dispersion (finite depth) ----
float dispersion(float k, float g, float depth) {
    return sqrt(g * k * tanh(min(k * depth, 20.0)));
}
float dispersionDerivative(float k, float g, float depth) {
    float th = tanh(min(k * depth, 20.0));
    float ch = cosh(min(k * depth, 20.0));
    return g * (depth * k / (ch * ch) + th) / dispersion(k, g, depth) * 0.5;
}

// ---- directional spreading ----
float normalisationFactor(float s) {
    float s2 = s * s, s3 = s2 * s, s4 = s3 * s;
    if (s < 5.0) return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
    return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
}
float cosine2s(float theta, float s) {
    return normalisationFactor(s) * pow(abs(cos(0.5 * theta)), 2.0 * s);
}
float spreadPower(float omega, float peakOmega) {
    if (omega > peakOmega) return 9.77 * pow(abs(omega / peakOmega), -2.5);
    return 6.97 * pow(abs(omega / peakOmega), 5.0);
}

// spectrum parameter block:
//   p0 = (scale, angle, spreadBlend, swell)
//   p1 = (alpha, peakOmega, gamma, shortWavesFade)
float directionSpectrum(float theta, float omega, vec4 p0, vec4 p1) {
    float s = spreadPower(omega, p1.y) + 16.0 * tanh(min(omega / p1.y, 20.0)) * p0.w * p0.w;
    float c = cos(theta);
    return mix(2.0 / PI * c * c, cosine2s(theta - p0.y, s), p0.z);
}
float tmaCorrection(float omega, float g, float depth) {
    float omegaH = omega * sqrt(depth / g);
    if (omegaH <= 1.0) return 0.5 * omegaH * omegaH;
    if (omegaH < 2.0) return 1.0 - 0.5 * (2.0 - omegaH) * (2.0 - omegaH);
    return 1.0;
}
float jonswap(float omega, float g, float depth, vec4 p0, vec4 p1) {
    float peakOmega = p1.y;
    float sigma = omega <= peakOmega ? 0.07 : 0.09;
    float d = (omega - peakOmega) / (sigma * peakOmega);
    float r = exp(-0.5 * d * d);
    float invOmega = 1.0 / omega;
    float pk = peakOmega * invOmega;
    return p0.x * tmaCorrection(omega, g, depth) * p1.x * g * g
         * invOmega * invOmega * invOmega * invOmega * invOmega
         * exp(-1.25 * pk * pk * pk * pk)
         * pow(abs(p1.z), r);
}
float shortWavesFade(float k, vec4 p1) {
    return exp(-p1.w * p1.w * k * k);
}

// complex helpers
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 cconj(vec2 a) { return vec2(a.x, -a.y); }
`;

// Full-screen quad vertex shader (engine chunk 'quadVS' provides aPosition / uv0)
export const SIM_QUAD_VS = /* glsl */`
attribute vec2 aPosition;
varying vec2 uv0;
void main(void) {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    uv0 = (aPosition.xy + 1.0) * 0.5;
}
`;

// ---------------------------------------------------------------------------
// Pass 1: initial spectrum H0(k) and conj(H0(-k)) -> RGBA32F
// ---------------------------------------------------------------------------
export const SPECTRUM_FS = /* glsl */`
${SIM_MATH_GLSL}
uniform int   uSize;
uniform float uLengthScale;
uniform float uCutoffLow;
uniform float uCutoffHigh;
uniform float uDepth;
uniform float uGravity;
uniform int   uSeed;
uniform vec4  uSpecA0, uSpecA1, uSpecB0, uSpecB1;

vec2 h0(ivec2 texel) {
    int n = uSize;
    float deltaK = TWO_PI / uLengthScale;
    int nx = texel.x < n / 2 ? texel.x : texel.x - n;
    int nz = texel.y < n / 2 ? texel.y : texel.y - n;
    vec2 k = vec2(float(nx), float(nz)) * deltaK;
    float kLen = length(k);
    if (kLen < uCutoffLow || kLen > uCutoffHigh || kLen < 1e-6) return vec2(0.0);

    float kAngle = atan(k.y, k.x);
    float omega = dispersion(kLen, uGravity, uDepth);
    float dOmegadk = dispersionDerivative(kLen, uGravity, uDepth);

    float spectrum = jonswap(omega, uGravity, uDepth, uSpecA0, uSpecA1)
                   * directionSpectrum(kAngle, omega, uSpecA0, uSpecA1)
                   * shortWavesFade(kLen, uSpecA1);
    if (uSpecB0.x > 0.0) {
        spectrum += jonswap(omega, uGravity, uDepth, uSpecB0, uSpecB1)
                  * directionSpectrum(kAngle, omega, uSpecB0, uSpecB1)
                  * shortWavesFade(kLen, uSpecB1);
    }
    vec2 xi = gaussian2(uvec2(texel), uint(uSeed));
    // h0 = (xi_r + i xi_i)/sqrt(2) * sqrt(Ph),  Ph = Psi(k) dk^2 / 2  =>  calibrated so that
    // the ensemble height variance equals the integral of the directional spectrum.
    return xi * 0.5 * sqrt(spectrum * abs(dOmegadk) / kLen * deltaK * deltaK);
}

void main(void) {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    ivec2 mirror = ivec2((uSize - texel.x) % uSize, (uSize - texel.y) % uSize);
    vec2 a = h0(texel);
    vec2 b = h0(mirror);
    gl_FragColor = vec4(a, cconj(b));
}
`;

// ---------------------------------------------------------------------------
// Pass 2: time evolution. Packs 8 real fields into 4 complex spectra (2 x RGBA32F):
//   out0 = ( Dx + i Dz ,  Dy + i dDx/dz )
//   out1 = ( dDy/dx + i dDy/dz ,  dDx/dx + i dDz/dz )
// ---------------------------------------------------------------------------
export const EVOLVE_FS = /* glsl */`
${SIM_MATH_GLSL}
uniform sampler2D uSpectrum;
uniform int   uSize;
uniform float uLengthScale;
uniform float uDepth;
uniform float uGravity;
uniform float uTime;

void main(void) {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(uSpectrum, texel, 0);
    int n = uSize;
    float deltaK = TWO_PI / uLengthScale;
    int nx = texel.x < n / 2 ? texel.x : texel.x - n;
    int nz = texel.y < n / 2 ? texel.y : texel.y - n;
    vec2 k = vec2(float(nx), float(nz)) * deltaK;
    float kLen = length(k);
    float invK = kLen > 1e-6 ? 1.0 / kLen : 0.0;
    float omega = dispersion(max(kLen, 1e-6), uGravity, uDepth);
    float phase = omega * uTime;
    vec2 e = vec2(cos(phase), sin(phase));
    vec2 h = cmul(s.xy, e) + cmul(s.zw, cconj(e));   // height spectrum h(k,t)
    vec2 ih = vec2(-h.y, h.x);                         // i*h

    // Horizontal displacement. Tessendorf writes D = sum -i (k/|k|) h e^{ikx} and then applies it
    // with a *negative* lambda; with the positive choppiness this simulation exposes, that sign
    // pushes surface points away from the crests and piles them into the troughs — sharp troughs,
    // broad crests, and whitecaps in the wrong place. So the sign is folded in here: +i (k/|k|) h,
    // which is the Gerstner convergence (points crowd the crest) for lambda > 0. The second
    // derivatives of D follow the same sign.
    vec2 Dx  = k.x * invK * ih;
    vec2 Dz  = k.y * invK * ih;
    vec2 Dy  = h;
    vec2 dyx = k.x * ih;
    vec2 dyz = k.y * ih;
    vec2 dxx = -k.x * k.x * invK * h;
    vec2 dzz = -k.y * k.y * invK * h;
    vec2 dxz = -k.x * k.y * invK * h;

    pcFragColor0 = vec4(Dx + vec2(-Dz.y, Dz.x),  Dy + vec2(-dxz.y, dxz.x));
    pcFragColor1 = vec4(dyx + vec2(-dyz.y, dyz.x), dxx + vec2(-dzz.y, dzz.x));
}
`;

// ---------------------------------------------------------------------------
// Pass 3: radix-2 Cooley-Tukey (decimation in time) inverse FFT, one stage per pass,
// horizontal then vertical. Bit-reversal permutation is folded into stage 0.
// Operates on two RGBA32F textures = four complex signals at once.
// ---------------------------------------------------------------------------
export const FFT_FS = /* glsl */`
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform int uSize;
uniform int uLog2Size;
uniform int uStage;       // 0 .. log2Size-1
uniform int uVertical;    // 0 = rows, 1 = columns

int bitReverse(int x) {
    int r = 0;
    for (int i = 0; i < uLog2Size; i++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
    }
    return r;
}

void main(void) {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    int x = uVertical == 1 ? texel.y : texel.x;
    int hs = 1 << uStage;
    int len = hs << 1;
    int k = x & (len - 1);
    bool upper = k >= hs;
    int j = upper ? k - hs : k;
    int i0 = upper ? x - hs : x;
    int i1 = i0 + hs;
    if (uStage == 0) { i0 = bitReverse(i0); i1 = bitReverse(i1); }

    ivec2 t0 = uVertical == 1 ? ivec2(texel.x, i0) : ivec2(i0, texel.y);
    ivec2 t1 = uVertical == 1 ? ivec2(texel.x, i1) : ivec2(i1, texel.y);

    float ang = 6.28318530717959 * float(j) / float(len);   // inverse transform: +i
    vec2 w = vec2(cos(ang), sin(ang));

    vec4 a0 = texelFetch(uIn0, t0, 0);
    vec4 b0 = texelFetch(uIn0, t1, 0);
    vec4 a1 = texelFetch(uIn1, t0, 0);
    vec4 b1 = texelFetch(uIn1, t1, 0);

    // complex multiply each of the 4 complex numbers by w
    vec4 wb0 = vec4(b0.x * w.x - b0.y * w.y, b0.x * w.y + b0.y * w.x,
                    b0.z * w.x - b0.w * w.y, b0.z * w.y + b0.w * w.x);
    vec4 wb1 = vec4(b1.x * w.x - b1.y * w.y, b1.x * w.y + b1.y * w.x,
                    b1.z * w.x - b1.w * w.y, b1.z * w.y + b1.w * w.x);

    pcFragColor0 = upper ? a0 - wb0 : a0 + wb0;
    pcFragColor1 = upper ? a1 - wb1 : a1 + wb1;
}
`;

// ---------------------------------------------------------------------------
// Pass 4: assemble displacement / derivative maps + temporal foam (Jacobian).
//   displacement = (lambda*Dx, Dy, lambda*Dz, turbulence)
//   derivatives  = (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
// ---------------------------------------------------------------------------
export const ASSEMBLE_FS = /* glsl */`
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform sampler2D uPrevDisplacement;
uniform float uLambda;
uniform float uDeltaTime;
uniform float uFoamDecay;   // recovery rate of the Jacobian (1/s)
uniform float uFoamReset;   // 1 = ignore history (first frame after a rebuild)

void main(void) {
    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec4 a = texelFetch(uIn0, texel, 0);
    vec4 b = texelFetch(uIn1, texel, 0);
    float Dx = a.x, Dz = a.y, Dy = a.z, dxz = a.w;
    float dyx = b.x, dyz = b.y, dxx = b.z, dzz = b.w;

    float jacobian = (1.0 + uLambda * dxx) * (1.0 + uLambda * dzz) - uLambda * uLambda * dxz * dxz;
    float prev = texelFetch(uPrevDisplacement, texel, 0).w;
    float turb = min(jacobian, prev + uDeltaTime * uFoamDecay / max(jacobian, 0.5));
    if (uFoamReset > 0.5) turb = jacobian;

    pcFragColor0 = vec4(uLambda * Dx, Dy, uLambda * Dz, turb);
    pcFragColor1 = vec4(dyx, dyz, dxx, dzz);
}
`;
