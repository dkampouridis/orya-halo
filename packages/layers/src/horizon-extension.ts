import { LayerExtension, project } from "@deck.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Hides the parts of a stock deck.gl layer that are behind the planet.
 *
 * The data layers draw in their own canvas above the map, so there is no
 * globe in their depth buffer to hide what is on the far side. This injects
 * the same analytic test the Orya Halo point layers use (`halo_visibility`)
 * into any layer that reports `geometry.position`, and discards fragments
 * past the limb, with a short fade so lines do not end in a hard cut.
 */
const horizonModule = {
  name: "haloHorizon",
  dependencies: [project],
  vs: /* glsl */ `\
out float haloHorizonVisibility;

float haloHorizon_visibility(vec3 commonPosition) {
  if (project.projectionMode != PROJECTION_MODE_GLOBE) {
    return 1.0;
  }
  vec3 camera = project.cameraPosition;
  vec3 ray = commonPosition - camera;
  float t = clamp(-dot(camera, ray) / max(dot(ray, ray), 1e-12), 0.0, 1.0);
  float nearest = length(camera + ray * t);
  return smoothstep(GLOBE_RADIUS * 0.9990, GLOBE_RADIUS * 0.99995, nearest);
}
`,
  fs: /* glsl */ `\
in float haloHorizonVisibility;
`,
  inject: {
    "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  haloHorizonVisibility = haloHorizon_visibility(geometry.position.xyz);
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
  if (haloHorizonVisibility < 0.02) discard;
  color.a *= haloHorizonVisibility;
`,
  },
} as const satisfies ShaderModule;

export class HorizonExtension extends LayerExtension {
  static override extensionName = "HorizonExtension";

  override getShaders(): { modules: ShaderModule[] } {
    return { modules: [horizonModule] };
  }
}
