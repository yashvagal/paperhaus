declare module 'upng-js' {
  const UPNG: {
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[]): ArrayBuffer;
    decode(buf: ArrayBuffer): { width: number; height: number; depth: number; ctype: number };
    toRGBA8(img: unknown): ArrayBuffer[];
  };
  export default UPNG;
}
