# Chrome Web Store assets

Start the local bridge, reload the unpacked extension if needed, and generate the upload-ready assets with:

```bash
npm run generate-store-assets
```

The artwork generator creates the icon and promo tiles deterministically. The screenshot command opens a neutral local demo tab, drives it through the real unpacked extension, captures the real HUD and element badges, and closes only that temporary tab.

The generated files are:

- `store-icon-128.png` — required 128 × 128 store icon.
- `screenshot-1280x800.jpg` — required product screenshot captured from a real `p agent extension` session on a neutral demo page.
- `small-promo-440x280.jpg` — required small promotional tile.
- `marquee-promo-1400x560.jpg` — optional marquee promotional tile.

The screenshot deliberately uses neutral sample content. Do not replace it with private browsing data, customer data, credentials, or a generic placeholder image.
