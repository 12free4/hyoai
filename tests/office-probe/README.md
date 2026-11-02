# Office browser verification

The probe pages and document fixtures live here so they are excluded from normal static exports.

Run `npm run test:office` for the automated parser, routing, localization, API and chunking tests.

To run the real browser checks:

1. Run `node tests/office-probe.mjs setup`.
2. Start `npm run dev` in another terminal.
3. Run `node tests/anydoc-probe-browser.mjs` and repeat with URL arguments `http://127.0.0.1:4117/anydoc-probe/?formats`, `?errors` and `?media`.
4. Run `node tests/office-ui-browser.mjs en`, then repeat with `fr` and `zh`.
5. Stop the development server and run `node tests/office-probe.mjs clean` before building for deployment.

For static verification, build while the probe is installed, serve `out` with a static HTTP server, and pass that server's probe URL to `anydoc-probe-browser.mjs`. For `BASE_PATH`, mount the export under the same prefix. Clean the probe and rebuild afterwards.

The tests use an isolated temporary Chrome profile and simulate file selection, clipboard and drag events. They do not validate the native file dialog or call a model API. Macro/slideshow variants are tested through extension mappings and renamed container samples; genuine DOCM, PPTM, PPSX, PPSM and XLSM samples remain to be validated. Fixture provenance and license are in `public/anydoc-probe/fixtures` within this directory.
