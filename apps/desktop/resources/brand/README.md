# EXIT-huisstijl: bronbestanden

- `exit-logo.svg` — EXIT Toys-logo, dezelfde file als `public/icons/exit-logo.svg` in het marketing dashboard. Ook gebruikt in de bovenbalk (`src/renderer/src/assets/exit-logo.svg`).
- `app-icon.svg` — app-icoon: het logo met witte rand en slagschaduw op een lichtblauwe squircle (lichtblauw is volgens het huisstijlhandboek de achtergrondkleur voor het logo), plus een oranje vergrootglas-badge.
- `palette.py` — rekent de oklch-kleuren van het dashboard om naar de RGB-triplets in `styles.css`.

## Iconen opnieuw maken

`app-icon.svg` renderen naar een PNG van 1024×1024, bijvoorbeeld met headless Chrome (in een HTML-pagina met transparante achtergrond):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --default-background-color=00000000 --window-size=1024,1024 --screenshot=icon-1024.png app-icon.html
```

Daarna:

- `icon.icns`: een `.iconset`-map met 16 t/m 1024 px (inclusief `@2x`), dan `iconutil -c icns`.
- `icon.ico`: `magick` met 256, 128, 64, 48, 32, 24 en 16 px.
- `icon.png`: 1024 px. `src/main/assets/window-icon.png`: 256 px.

Het tray-icoon (de witte EXIT-vorm met uitgespaarde letters, 32×32) staat als base64 in `src/main/index.ts` (`TRAY_ICON_PNG_BASE64`).
