// Vite serves a file imported with ?raw as its text. Ambient wildcard modules must live in a global file.
declare module "*?raw" {
  const text: string;
  export default text;
}
