# RailWise AI interface fonts

Both WOFF2 files come from the variable `kun/assets/fonts/NotoSansSC.ttf`
pinned in the repository. The main face retains the complete character map.
The startup subset contains ASCII and the characters used by the Chinese
product name and startup status messages. The included SIL Open Font License
also applies to both WOFF2 files.

From the repository root, regenerate the assets with fontTools:

```sh
uv run --no-project --with 'fonttools[woff]==4.63.0' -- fonttools ttLib.woff2 compress \
  kun/assets/fonts/NotoSansSC.ttf -o src/asset/ui-fonts/NotoSansSC.woff2
uv run --no-project --with 'fonttools[woff]==4.63.0' -- pyftsubset \
  kun/assets/fonts/NotoSansSC.ttf --flavor=woff2 --unicodes=U+0020-007E \
  --text='基于本地优先架构的智能协同工作台正在准备区启动服务载入扩展打开已就绪' \
  --output-file=src/asset/ui-fonts/NotoSansSC-Splash.woff2
```
