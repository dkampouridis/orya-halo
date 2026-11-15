import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { invert4 } from "../maths.ts";
import { liftFS, spaceFS, spaceVS } from "./space-shaders.ts";

export interface SpaceLayerState {
  /** Unit vector to the sun in MapLibre's globe frame. */
  sun: [number, number, number];
  /** 0..1 strength of night shading and the terminator. */
  night: number;
  /** 0..1: how dark full night is. Near-black from orbit, lighter up close so streets stay readable. */
  shade: number;
  /** 0..1 strength of the city lights (already faded for zoom). */
  lights: number;
  /** 0..1 */
  stars: number;
  /** Draw the dense layer of faint stars as well as the bright ones. */
  faintStars: boolean;
  /** City lights at their best: a wide glow round lit regions, and smooth when stretched. */
  lightsFine: boolean;
  /** 0..1 */
  rim: number;
  rimColor: [number, number, number];
  lightColor: [number, number, number];
}

const UNIFORMS = [
  "u_flat",
  "u_sun",
  "u_night",
  "u_shade",
  "u_lights",
  "u_lightsLod",
  "u_lightsSize",
  "u_fine",
  "u_stars",
  "u_faintStars",
  "u_rim",
  "u_rimColor",
  "u_lightColor",
  "u_lightsMap",
] as const;
const LIFT_UNIFORMS = ["u_flat", "u_sun", "u_night"] as const;

// Clip-space corners of the screen, as a triangle strip.
const CORNERS = [-1, -1, 1, -1, -1, 1, 1, 1];
const FLOATS_PER_VERTEX = 8;

interface GlResources {
  program: WebGLProgram;
  lift: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  texture: WebGLTexture;
  uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  liftUniforms: Record<(typeof LIFT_UNIFORMS)[number], WebGLUniformLocation | null>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Space layer shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create a program for the sky");
  const vs = compile(gl, gl.VERTEX_SHADER, spaceVS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.bindAttribLocation(program, 1, "a_near");
  gl.bindAttribLocation(program, 2, "a_far");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Space layer program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/**
 * MapLibre custom layer for the sky and the day/night treatment. It is a map
 * layer, not a deck.gl one, so it sits under the place labels and repaints
 * only when the map does.
 */
export class SpaceLayer implements CustomLayerInterface {
  readonly id = "halo-space";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private res: GlResources | null = null;
  private image: ImageBitmap | null = null;
  private loading: Promise<void> | null = null;
  private imageUploaded = false;
  private textureWidth = 1;
  private textureHeight = 1;
  private readonly vertices = new Float32Array(4 * FLOATS_PER_VERTEX);
  private readonly inverse = new Float64Array(16);
  private readonly state: SpaceLayerState;
  private readonly lightsUrl: string;
  private map: MapLibreMap | null = null;

  constructor(state: SpaceLayerState, lightsUrl: string) {
    this.state = state;
    this.lightsUrl = lightsUrl;
  }

  /** True once the city lights image is on the GPU. */
  get lightsReady(): boolean {
    return this.imageUploaded;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.build(gl);
    void this.loadLights();
  }

  /**
   * Fetch and decode the city lights. Resolves when the image is ready to
   * upload (or could not be had: the night side is then simply dark, and
   * nothing else depends on it). Decoding happens off the main thread; an
   * `<img>` handed to WebGL is decoded where it stands, in the middle of a
   * frame, which for 3600 x 1800 pixels is a visible stall.
   */
  loadLights(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const response = await fetch(this.lightsUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.image = await createImageBitmap(await response.blob(), {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        });
        this.map?.triggerRepaint();
      } catch (error) {
        console.warn(
          `Orya Halo: the city lights image did not load (${this.lightsUrl}): ${String(error)}`,
        );
      }
    })();
    return this.loading;
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    // On a lost context these are no-ops; the objects went with the context.
    if (this.res && !gl.isContextLost()) {
      gl.deleteProgram(this.res.program);
      gl.deleteProgram(this.res.lift);
      gl.deleteVertexArray(this.res.vao);
      gl.deleteBuffer(this.res.buffer);
      gl.deleteTexture(this.res.texture);
    }
    this.res = null;
    this.map = null;
    this.imageUploaded = false;
  }

  /**
   * The context was lost: everything on the GPU is gone. MapLibre drops its
   * style, and custom layers with it, so the engine adds this layer again
   * once the context is back; `onAdd` then builds from scratch. The decoded
   * lights image is kept, so it is uploaded again without a download.
   */
  contextLost(): void {
    this.res = null;
    this.imageUploaded = false;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const res = this.res;
    if (!res) return;
    const data = args.defaultProjectionData;
    // Transition 0 means MapLibre has fully eased into Mercator (street level).
    const flat = data.projectionTransition <= 0;
    if (!invert4(data.mainMatrix, this.inverse)) return;
    this.updateRays();

    const s = this.state;
    gl.bindVertexArray(res.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    if (s.night > 0) {
      // Daylight first: destination * (1 + source), alpha left alone.
      const lu = res.liftUniforms;
      gl.useProgram(res.lift);
      gl.uniform1f(lu.u_flat, flat ? 1 : 0);
      gl.uniform3f(lu.u_sun, s.sun[0], s.sun[1], s.sun[2]);
      gl.uniform1f(lu.u_night, s.night);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.useProgram(res.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.texture);
    if (this.image && !this.imageUploaded) this.uploadLights(gl);

    const u = res.uniforms;
    gl.uniform1f(u.u_flat, flat ? 1 : 0);
    gl.uniform3f(u.u_sun, s.sun[0], s.sun[1], s.sun[2]);
    gl.uniform1f(u.u_night, s.night);
    gl.uniform1f(u.u_shade, s.shade);
    gl.uniform1f(u.u_lights, this.imageUploaded ? s.lights : 0);
    gl.uniform1f(u.u_lightsLod, this.textureWidth / (2 * Math.PI));
    gl.uniform2f(u.u_lightsSize, this.textureWidth, this.textureHeight);
    gl.uniform1f(u.u_fine, s.lightsFine ? 1 : 0);
    gl.uniform1f(u.u_stars, s.stars);
    gl.uniform1f(u.u_faintStars, s.faintStars ? 1 : 0);
    gl.uniform1f(u.u_rim, s.rim);
    gl.uniform3f(u.u_rimColor, s.rimColor[0], s.rimColor[1], s.rimColor[2]);
    gl.uniform3f(u.u_lightColor, s.lightColor[0], s.lightColor[1], s.lightColor[2]);
    gl.uniform1i(u.u_lightsMap, 0);

    // Premultiplied output: alpha darkens the map, rgb adds light on top.
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private build(gl: WebGL2RenderingContext): void {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!vao || !buffer || !texture) throw new Error("Could not create WebGL objects for the sky");
    const program = link(gl, spaceFS);
    const lift = link(gl, liftFS);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERTEX * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);

    // A 1x1 black texel stands in until the lights image arrives.
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    const uniforms = {} as GlResources["uniforms"];
    for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
    const liftUniforms = {} as GlResources["liftUniforms"];
    for (const name of LIFT_UNIFORMS) liftUniforms[name] = gl.getUniformLocation(lift, name);
    this.res = { program, lift, vao, buffer, texture, uniforms, liftUniforms };
  }

  private uploadLights(gl: WebGL2RenderingContext): void {
    const image = this.image;
    if (!image) return;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textureWidth = image.width;
    this.textureHeight = image.height;
    this.imageUploaded = true;
  }

  /** Unproject the four screen corners at the near and far planes. */
  private updateRays(): void {
    const m = this.inverse;
    const v = this.vertices;
    for (let i = 0; i < 4; i++) {
      const x = CORNERS[i * 2];
      const y = CORNERS[i * 2 + 1];
      const at = i * FLOATS_PER_VERTEX;
      v[at] = x;
      v[at + 1] = y;
      for (let plane = 0; plane < 2; plane++) {
        const z = plane === 0 ? -1 : 1;
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        const o = at + 2 + plane * 3;
        v[o] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        v[o + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        v[o + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      }
    }
  }
}
