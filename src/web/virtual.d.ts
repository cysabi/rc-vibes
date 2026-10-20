// Modules the build makes (vite.config.ts).

/** The color editor's backdrop tables, worked out from the bulb's solve and packed (cutoffs.ts): their URL. */
declare module "virtual:cutoffs" {
  const url: string;
  export default url;
}
