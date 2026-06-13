#version 300 es
precision highp float;

#define MAX_HSL_BANDS 8

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_source;
uniform vec2 u_sourceSize;
uniform float u_time;

uniform vec4 u_adjust0;
uniform vec4 u_adjust1;
uniform vec4 u_adjust2;
uniform float u_grain;

uniform vec4 u_hslBandMinMaxSoft[3 * MAX_HSL_BANDS];
uniform vec4 u_hslBandShiftSatLight[3 * MAX_HSL_BANDS];
uniform int u_hslBandCount;

uniform float u_skinProtection;
uniform sampler2D u_curveLut;
uniform vec4 u_splitShadow;
uniform vec4 u_splitHighlight;
uniform vec2 u_splitBalance;
uniform float u_effectIntensity;

float clamp01(float x) { return clamp(x, 0.0, 1.0); }

float smoothstepF(float edge0, float edge1, float x) {
  float t = clamp01((x - edge0) / max(edge1 - edge0, 1e-6));
  return t * t * (3.0 - 2.0 * t);
}

float mixToward(float current, float target, float amount) {
  return current + (target - current) * amount;
}

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

  float temp = temperature;
  color.r *= 1.0 + temp * 0.18;
  color.g *= 1.0 + (1.0 - abs(temp - 0.5) * 2.0) * 0.04;
  color.b *= 1.0 - temp * 0.18;

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

  float rLut = texture(u_curveLut, vec2(color.r, 0.5)).r;
  float gLut = texture(u_curveLut, vec2(color.g, 0.5)).r;
  float bLut = texture(u_curveLut, vec2(color.b, 0.5)).r;
  color = vec3(rLut, gLut, bLut);

  float distFromMid = (baseLight - 0.5) * 2.0;
  float balance = u_splitBalance.x * 2.0 - 1.0;
  float intensity = u_splitBalance.y;

  float shadowWeight = clamp01((1.0 - distFromMid) * (1.0 - max(0.0, balance)));
  float highlightWeight = clamp01((1.0 + distFromMid) * (1.0 + min(0.0, balance)));

  color += u_splitShadow.rgb * shadowWeight * intensity * 0.5;
  color += u_splitHighlight.rgb * highlightWeight * intensity * 0.5;

  vec2 centered = v_texCoord * 2.0 - 1.0;
  float distToCenter = length(centered);
  float vignetteAmount = 1.0 - smoothstepF(0.4, 1.1, distToCenter) * vignette;
  color *= vignetteAmount;

  color = mix(color, vec3(0.5), fade * 0.5);

  if (u_grain > 0.0) {
    vec2 pixelCoord = v_texCoord * u_sourceSize;
    float noise = sineNoise(pixelCoord.x, pixelCoord.y + u_time * 100.0) - 0.5;
    color += noise * u_grain * 0.18;
  }

  color = clamp01(color);
  outColor = vec4(color, 1.0);
}
