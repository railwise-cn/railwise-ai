# Selected artwork

The user selected `RAILWISE_AI_symbol_color.svg` and the byte-identical `RAILWISE_AI_symbol_color_512.png` from clean pack v2. Other pack files are retained as reference only.

`npm run generate:icons` reads the selected SVG, retains all nontransparent ribbon pixels and adds a two-source-pixel antialiasing margin. It generates a tightly framed transparent mark for startup and animation. Installer tiles use the same mark at 832px wide on a 1024px light or dark background. macOS adds standard 84% outer icon padding; Windows uses the dark tile. The runtime hero uses a 64px-wide mark (52px in a narrow container), without a second icon tile. The startup mark is 112px wide.

Original artwork is not repainted, denoised, or distorted. The generator changes placement and transparent canvas bounds only.
