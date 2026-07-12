// Text imports — esbuild bundles these with loader: { ".html": "text" }.
declare module "*.html" {
  const content: string;
  export default content;
}
