#version 300 es
precision highp float;

#define MAX_HSL_BANDS 8

in vec2 v_texCoord;
out vec4 outColor;

// The four samplers are bound to fixed texture units by the WebGL
// backend's `applyUniforms` (which calls `gl.activeTexture(TEXTURE0)`
// for the source and `gl.activeTexture(TEXTURE1/2/3)` for the three
// curve LUTs, then `gl.uniform1i(..., 0/1/2/3)` for the matching
// samplers). GLSL ES 3.00 (WebGL2) does not support the
// `layout(binding = N)` qualifier -- that requires GLSL ES 3.10 +
// the `GL_EXT_pixel_local_storage` extension -- so the binding is
// established programmatically via `uniform1i` rather than in the
// shader source. Declaration order in this file matches the units
// 0,1,2,3 the backend uses, which is what `uniform1i` would
// resolve to anyway, so the two approaches agree.
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
uniform float u_time;

uniform vec4 u_adjust0;
uniform vec4 u_adjust1;
uniform vec4 u_adjust2;
uniform float u_grain;

uniform vec4 u_hslBandMinMaxSoft[MAX_HSL_BANDS];
uniform vec4 u_hslBandShiftSatLight[MAX_HSL_BANDS];
uniform int u_hslBandCount;

uniform float u_skinProtection;
uniform sampler2D u_curveLutR;
uniform sampler2D u_curveLutG;
uniform sampler2D u_curveLutB;
uniform vec4 u_splitShadow;
uniform vec4 u_splitHighlight;
uniform vec2 u_splitBalance;
uniform float u_effectIntensity;

float clamp01(float x) { return clamp(x, 0.0, 1.0); }
vec3 clamp01(vec3 x) { return clamp(x, vec3(0.0), vec3(1.0)); }

float smoothstepF(float edge0, float edge1, float x) {
  float t = clamp01((x - edge0) / max(edge1 - edge0, 1e-6));
  return t * t * (3.0 - 2.0 * t);
}

float mixToward(float current, float target, float amount) { return mix(current, target, clamp01(amount)); }
vec3 mixToward(vec3 current, vec3 target, float amount) { return mix(current, target, clamp01(amount)); }

float luminanceF(float r, float g, float b) {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

float hueDistance(float a, float b) {
  float diff = abs(mod((a - b) - 180.0, 360.0) - 180.0);
  return diff;
}

float bandCenter(float minHue, float maxHue) {
  if (minHue <= maxHue) return (minHue + maxHue) * 0.5;
  float wrappedMax = maxHue + 360.0;
  float center = (minHue + wrappedMax) * 0.5;
  return center >= 360.0 ? center - 360.0 : center;
}

float bandWidth(float minHue, float maxHue) {
  if (minHue <= maxHue) return maxHue - minHue;
  return 360.0 - minHue + maxHue;
}

float bandInfluence(float hue, float minHue, float maxHue, float softness) {
  float width = max(8.0, bandWidth(minHue, maxHue));
  float center = bandCenter(minHue, maxHue);
  float hardRadius = max(1.0, width * 0.5);
  return 1.0 - smoothstepF(hardRadius, hardRadius + softness, hueDistance(hue, center));
}

vec3 rgbToHsl(vec3 c) {
  float maxC = max(max(c.r, c.g), c.b);
  float minC = min(min(c.r, c.g), c.b);
  float lightness = (maxC + minC) * 0.5;
  if (maxC == minC) return vec3(0.0, 0.0, lightness);

  float delta = maxC - minC;
  float saturation = lightness > 0.5 ? delta / (2.0 - maxC - minC) : delta / (maxC + minC);
  float hue = 0.0;
  if (maxC == c.r) hue = (c.g - c.b) / delta + (c.g < c.b ? 6.0 : 0.0);
  else if (maxC == c.g) hue = (c.b - c.r) / delta + 2.0;
  else hue = (c.r - c.g) / delta + 4.0;

  return vec3((hue / 6.0) * 360.0, saturation, lightness);
}

float hueToChannel(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hslToRgb(float h, float s, float l) {
  float hue = mod(mod(h, 360.0) + 360.0, 360.0) / 360.0;
  float saturation = clamp01(s);
  float lightness = clamp01(l);

  if (saturation == 0.0) {
    return vec3(lightness);
  }
  float q = lightness < 0.5
    ? lightness * (1.0 + saturation)
    : lightness + saturation - lightness * saturation;
  float p = 2.0 * lightness - q;

  return vec3(
    hueToChannel(p, q, hue + 1.0 / 3.0),
    hueToChannel(p, q, hue),
    hueToChannel(p, q, hue - 1.0 / 3.0)
  );
}

float sineNoise(float x, float y) {
  float raw = sin(x * 127.1 + y * 311.7) * 43758.5453;
  return raw - floor(raw);
}

void main() {
  vec3 color = texture(u_source, v_texCoord).rgb;

  float brightness   = u_adjust0.x;
  float contrast     = u_adjust0.y;
  float highlights   = u_adjust0.z;
  float shadows      = u_adjust0.w;
  float whites       = u_adjust1.x;
  float blacks       = u_adjust1.y;
  float temperature  = u_adjust1.z;
  float tint         = u_adjust1.w;
  float saturation   = u_adjust2.x;
  float vibrance     = u_adjust2.y;
  float fade         = u_adjust2.z;
  float vignette     = u_adjust2.w;

  float lum = luminanceF(color.r, color.g, color.b);
  float shadowMask = 1.0 - smoothstepF(0.08, 0.52, lum);
  float highlightMask = smoothstepF(0.48, 0.96, lum);
  float whiteMask = smoothstepF(0.7, 1.0, lum);
  float blackMask = 1.0 - smoothstepF(0.0, 0.28, lum);

  color += vec3(brightness * 0.16);

  float contrastFactor = 1.0 + contrast * 0.82;
  color = (color - 0.5) * contrastFactor + 0.5;

  color = mixToward(color, vec3(sign(highlights) >= 0.0 ? 1.0 : 0.0), abs(highlights) * highlightMask * 0.22);
  color += vec3(highlights < 0.0 ? highlightMask * highlights * 0.08 : 0.0);

  color = mixToward(color, vec3(sign(shadows) >= 0.0 ? 1.0 : 0.0), abs(shadows) * shadowMask * 0.18);
  color += vec3(shadows < 0.0 ? shadowMask * shadows * 0.08 : 0.0);

  color = mixToward(color, vec3(sign(whites) >= 0.0 ? 1.0 : 0.0), abs(whites) * whiteMask * 0.28);
  color += vec3(whites < 0.0 ? whiteMask * whites * 0.12 : 0.0);

  color = mixToward(color, vec3(sign(blacks) >= 0.0 ? 0.08 : 0.0), abs(blacks) * blackMask * 0.26);
  color += vec3(blacks < 0.0 ? blackMask * blacks * 0.09 : 0.0);

  // Temperature parity with the JS engine's getTemperatureScale:
  //   amount >= 0  -> R * lerp(1, 1.1, amount), G * lerp(1, 1.02, amount),
  //                   B * lerp(1, 0.9, amount)
  //   amount <  0  -> R * lerp(1, 0.9, cool),    G * lerp(1, 0.97, cool),
  //                   B * lerp(1, 1.12, cool)
  // The previous "1.0 + temp * 0.18" linear ramp diverged in two ways:
  // it lifted green at temp=0 (1.04 instead of 1.0), and used a single
  // symmetric slope for warm vs cool. Mirror the JS piecewise lerp.
  if (temperature >= 0.0) {
    color.r *= 1.0 + 0.10 * temperature;
    color.g *= 1.0 + 0.02 * temperature;
    color.b *= 1.0 - 0.10 * temperature;
  } else {
    float cool = -temperature;
    color.r *= 1.0 - 0.10 * cool;
    color.g *= 1.0 - 0.03 * cool;
    color.b *= 1.0 + 0.12 * cool;
  }

  color.r += tint * 0.02;
  color.g -= tint * 0.03;
  color.b += tint * 0.012;

  color = clamp01(color);

  vec3 hsl = rgbToHsl(color);
  float baseHue = hsl.x;
  float baseSat = hsl.y;
  float baseLight = hsl.z;

  bool skinLike = baseHue >= 16.0 && baseHue <= 54.0
    && baseSat >= 0.12 && baseSat <= 0.7
    && baseLight >= 0.18 && baseLight <= 0.86;
  float skinGuard = skinLike ? 1.0 - u_skinProtection * 0.55 : 1.0;

  float newSat = clamp01(baseSat * (1.0 + saturation * skinGuard));
  float vibHeadroom = vibrance > 0.0 ? 1.0 - newSat : newSat;
  float vibDirection = vibrance > 0.0 ? 1.0 : -1.0;
  newSat = clamp01(newSat + vibHeadroom * abs(vibrance) * 0.75 * skinGuard * vibDirection);

  float newHue = baseHue;
  float newLight = baseLight;

  for (int i = 0; i < MAX_HSL_BANDS; i++) {
    if (i >= u_hslBandCount) break;
    vec4 minMaxSoft = u_hslBandMinMaxSoft[i];
    vec4 shiftSatLight = u_hslBandShiftSatLight[i];
    float minHue = minMaxSoft.x;
    float maxHue = minMaxSoft.y;
    float softness = minMaxSoft.w;
    float hueShift = shiftSatLight.x;
    float satDelta = shiftSatLight.y;
    float lightDelta = shiftSatLight.z;
    float influence = bandInfluence(baseHue, minHue, maxHue, softness);
    if (influence <= 0.001) continue;
    newHue += hueShift * influence * skinGuard;
    newSat = clamp01(newSat * (1.0 + satDelta * influence * skinGuard));
    newLight = clamp01(newLight + lightDelta * influence * 0.6 * skinGuard);
  }

  color = hslToRgb(newHue, newSat, newLight);

  if (saturation <= -1.0 && vibrance <= -1.0) {
    float gray = luminanceF(color.r, color.g, color.b);
    color = vec3(gray);
  }

  // Per-channel curve LUTs. The JS engine composes
  //   sample(masterLut, sample(channelLut, value))
  // for each channel. The backend bakes the composition into a
  // single 256-entry lookup per channel (so the shader is one
  // texture sample per channel). The previous shader read the same
  // master LUT for R, G, and B, which silently dropped the
  // per-channel curves (a known gap acknowledged in the
  // webgl-preview skill).
  float rLut = texture(u_curveLutR, vec2(color.r, 0.5)).r;
  float gLut = texture(u_curveLutG, vec2(color.g, 0.5)).r;
  float bLut = texture(u_curveLutB, vec2(color.b, 0.5)).r;
  color = vec3(rLut, gLut, bLut);

  // Split tone parity with the JS engine's applySplitTone in
  // src/lib/filters/index.ts: post-HSL luminance, smoothstep mask
  // shape, `balancePivot = 0.5 + balance/200`. u_splitBalance.x is
  // already (balance+100)/200 (see packSplitToneUniforms), so
  // `0.5 + (u_splitBalance.x - 0.5)` simplifies to `u_splitBalance.x`.
  // The previous shader used a linear ramp mask and the pre-HSL
  // baseLight -- the masks landed in the wrong luminance range and
  // the magnitude was clipped. We also drive the amount by the
  // u_splitShadow/highlight `.a` slots, which now carry the
  // saturation that was driving the amount in the JS path
  // (multiplied by 0.32 / 0.28 to keep magnitudes similar).
  float postLum = luminanceF(color.r, color.g, color.b);
  float balancePivot = u_splitBalance.x;
  // Local split-tone masks. The tonal-shaping pass above already
  // declared `shadowMask` / `highlightMask`, so this block uses
  // distinct names to avoid a GLSL `redefinition` error. The two
  // pairs are intentionally separate: the tonal masks use fixed
  // thresholds (0.08..0.52 and 0.48..0.96), while the split-tone
  // masks pivot on the user's `u_splitBalance.x` so the shadow /
  // highlight split follows the balance slider.
  float splitShadowMask = 1.0 - smoothstepF(0.08, balancePivot, postLum);
  float splitHighlightMask = smoothstepF(balancePivot, 0.98, postLum);
  // The .a slot of the shadow / highlight tints carries the
  // saturation that the JS engine multiplies by 0.32 (shadow) and
  // 0.28 (highlight). We use that here so the magnitude is driven
  // by the per-tint saturation rather than the average. u_splitBalance.y
  // remains the average saturation (kept for backwards-compatibility
  // with the existing dev tools that read it).
  color += u_splitShadow.rgb * splitShadowMask * u_splitShadow.a * 0.32;
  color += u_splitHighlight.rgb * splitHighlightMask * u_splitHighlight.a * 0.28;

  // Vignette parity with the JS engine's finalPass in
  // src/lib/filters/index.ts: distance is normalized to 1 at the
  // corners (`sqrt(cx^2 + cy^2) / maxDistance`), the smoothstep
  // window is 0.4..1 (not 0.4..1.1), and the darkening strength is
  // 0.38. The previous shader used an un-normalized Euclidean
  // distance and a 0.4..1.1 window, which gave a softer, smaller
  // vignette. Use the image's pixel dimensions to compute the
  // normalized distance, then apply the JS strength.
  vec2 pixelPos = v_texCoord * u_sourceSize;
  vec2 centerPx = u_sourceSize * 0.5;
  float maxDist = length(centerPx);
  float distNorm = length(pixelPos - centerPx) / maxDist;
  float vignetteMask = smoothstepF(0.4, 1.0, distNorm);
  float vignetteAmount = vignetteMask * vignette * 0.38;
  color = color * (1.0 - vignetteAmount);

  // Fade parity: the JS engine's applyFade lifts toward white
  // (1.0) by clamp01(amount/100); the previous shader was mixing
  // toward 0.5 (grey) by `fade * 0.5`. The lifted target should be
  // white, not grey. `fade` arrives as a 0..1 value (the backend
  // divides by 100), so we use it directly.
  color = mix(color, vec3(1.0), fade);

  if (u_grain > 0.0) {
    // Grain parity with the JS engine's finalPass in
    // src/lib/filters/index.ts: sample noise per pixel with a chroma
    // offset, modulate by a tonal weight (1 at midtones, 0 at the
    // extremes), apply per-channel ratios. The JS grain is *static*
    // (no per-frame animation), so we drop the u_time term here. The
    // texture is uploaded bottom-up but the noise function expects
    // top-down pixel coordinates, so we flip the y axis.
    vec2 pixelCoord = v_texCoord * u_sourceSize;
    float lum = luminanceF(color.r, color.g, color.b);
    float tonalWeight = clamp01(1.0 - abs(lum - 0.5) * 1.25);
    float baseNoise = sineNoise(pixelCoord.x, u_sourceSize.y - pixelCoord.y) - 0.5;
    float chromaNoise = sineNoise(pixelCoord.x + 23.17, u_sourceSize.y - pixelCoord.y + 11.13) - 0.5;
    float amount = u_grain * tonalWeight * (14.0 / 255.0);
    color.r += baseNoise * amount * 1.05;
    color.g += (baseNoise * 0.85 + chromaNoise * 0.15) * amount;
    color.b += (baseNoise * 0.7 - chromaNoise * 0.2) * amount;
  }

  // Effect intensity blend. The JS engine's blendEffectIntensity lerps
  // from the original (pre-filter) pixel toward the filtered result by
  // `effectIntensity` (0..1, already normalized in the uniform). The
  // WebGL shader was setting the uniform but never reading it, so the
  // preview always showed the fully-filtered result even when the user
  // asked for 50% effect strength. Sample the source texture again and
  // lerp from it.
  if (u_effectIntensity < 1.0) {
    vec3 originalColor = texture(u_source, v_texCoord).rgb;
    color = mix(originalColor, color, u_effectIntensity);
  }

  color = clamp01(color);
  outColor = vec4(color, 1.0);
}
