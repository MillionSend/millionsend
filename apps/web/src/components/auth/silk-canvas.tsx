"use client";

import { useEffect, useRef } from "react";
import styles from "./auth.module.css";

/**
 * Live silk backdrop: a dependency-free WebGL fragment shader draws endlessly
 * flowing cloth folds (domain-warped fbm noise, lit top-left with a specular
 * sheen). Renders nothing under prefers-reduced-motion or without WebGL — the
 * static webp beneath stays visible instead. Palette follows [data-theme].
 */

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform vec3 u_base;
uniform vec3 u_sheen;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
// Linear drape: parallel folds along one direction, organically warped.
// Constants picked live in the Silk Backdrop Lab: folds 9, warp 0.2,
// speed 3, angle 115 deg, sheen 0.6.
float height(vec2 uv, float t){
  float a = radians(115.0);
  vec2 d = vec2(cos(a), sin(a));
  vec2 perp = vec2(-d.y, d.x);
  float along = dot(uv, perp);
  float bend = (fbm(uv * 1.1 + t * 0.15) - 0.5) * 0.44;
  float p = (dot(uv, d) + bend) * 9.0 - t;
  float amp = 0.6 + 0.4 * fbm(vec2(along * 0.9, p * 0.08) + t * 0.05);
  return amp * (0.55 * sin(p) + 0.28 * sin(p * 2.17 + 1.7) + 0.17 * sin(p * 0.53 + 4.2)) * 0.5 + 0.5;
}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  uv.x *= u_res.x / u_res.y;
  float t = u_time * 0.3;
  float h = height(uv, t);
  float hx = height(uv + vec2(0.012, 0.0), t) - h;
  float hy = height(uv + vec2(0.0, 0.012), t) - h;
  vec3 n = normalize(vec3(-hx, -hy, 0.05));
  vec3 l = normalize(vec3(0.25, 0.7, 0.65));
  float diff = clamp(dot(n, l), 0.0, 1.0);
  float spec = pow(clamp(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 24.0);
  vec3 col = u_base * (0.55 + 0.5 * diff) + u_sheen * spec * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`;

const PALETTES = {
  dark: { base: [0.055, 0.062, 0.078], sheen: [0.498, 0.529, 0.569] },
  light: { base: [0.906, 0.894, 0.867], sheen: [1.0, 0.988, 0.949] },
} as const;

function activePalette(): (typeof PALETTES)[keyof typeof PALETTES] {
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "light" ? PALETTES.light : PALETTES.dark;
}

export function SilkCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const gl = canvas.getContext("webgl", {
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const shader = gl.createShader(type) as WebGLShader;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    };
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "u_time");
    const uRes = gl.getUniformLocation(program, "u_res");
    const uBase = gl.getUniformLocation(program, "u_base");
    const uSheen = gl.getUniformLocation(program, "u_sheen");

    let palette = activePalette();
    // The theme toggle rewrites data-theme on <html>; follow it live.
    const observer = new MutationObserver(() => {
      palette = activePalette();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // DPR capped: fbm per pixel is the cost driver and folds are soft anyway.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
    const resize = () => {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    const start = performance.now();
    const draw = () => {
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform3fv(uBase, palette.base);
      gl.uniform3fv(uSheen, palette.sheen);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frame = requestAnimationFrame(draw);
    };
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden) frame = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", resize);
      observer.disconnect();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" tabIndex={-1} />;
}
