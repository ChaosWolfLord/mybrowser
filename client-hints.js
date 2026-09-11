// Runs in every page before the page's own scripts.
//
// The user-agent string claims Chrome, but Electron's User-Agent Client Hints
// (navigator.userAgentData) list only "Chromium", never the "Google Chrome"
// brand that a genuine Chrome always reports. Google's sign-in reads exactly
// that and refuses with "this browser or app may not be secure". This adds
// the missing brand back so the hints match the user-agent, mirroring the
// version Chromium already reports for itself rather than inventing one.
const { contextBridge } = require('electron');

try {
  contextBridge.executeInMainWorld({
    func: () => {
      const real = navigator.userAgentData;
      if (!real || !Array.isArray(real.brands)) return;
      if (real.brands.some((b) => b && b.brand === 'Google Chrome')) return;

      // Copy the Chromium entry but relabel it Google Chrome, so its version
      // (major in `brands`, full in `fullVersionList`) always matches.
      const withChrome = (list) => {
        if (!Array.isArray(list)) return list;
        if (list.some((b) => b && b.brand === 'Google Chrome')) return list;
        const chromium = list.find((b) => b && b.brand === 'Chromium');
        if (!chromium) return list;
        return list.concat([{ brand: 'Google Chrome', version: chromium.version }]);
      };

      const fake = {
        get brands() { return withChrome(real.brands); },
        get mobile() { return real.mobile; },
        get platform() { return real.platform; },
        getHighEntropyValues(hints) {
          return real.getHighEntropyValues(hints).then((values) => {
            if (values && values.brands) values.brands = withChrome(values.brands);
            if (values && values.fullVersionList) values.fullVersionList = withChrome(values.fullVersionList);
            return values;
          });
        },
        toJSON() {
          return { brands: withChrome(real.brands), mobile: real.mobile, platform: real.platform };
        }
      };

      try {
        Object.defineProperty(navigator, 'userAgentData', {
          configurable: true,
          get: () => fake
        });
      } catch (err) {
        // Some pages lock navigator down; nothing more we can do there.
      }
    }
  });
} catch (err) {
  // An older Electron without executeInMainWorld: load the page anyway.
}
