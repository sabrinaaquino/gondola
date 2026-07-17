// ffprobe-static ships no type declarations; it exports the path to the bundled
// ffprobe binary for the current platform.
declare module "ffprobe-static" {
  const ffprobe: { path: string };
  export default ffprobe;
}
