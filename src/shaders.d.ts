// GLSL sources and SVG artwork are bundled as plain strings (esbuild "text" loader).
declare module '*.vert' {
  const source: string;
  export default source;
}

declare module '*.frag' {
  const source: string;
  export default source;
}

declare module '*.glsl' {
  const source: string;
  export default source;
}

declare module '*.svg' {
  const source: string;
  export default source;
}
