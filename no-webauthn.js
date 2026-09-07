// Runs in every page the browser loads, before that page's own scripts.
//
// Google's sign-in page calls navigator.credentials.get({publicKey}) the
// moment it loads. Windows answers that with its own security-key dialog,
// which the browser cannot decline for you -- so if anything ever loads a
// sign-in page on its own, you get a modal box you did not ask for and have
// to dismiss by hand. There is no permission hook for this in Electron: the
// only place to stand is inside the page, before it runs.
//
// Ordinary password sign-in is untouched. Only publicKey requests -- the
// passkey and security-key kind -- are refused, and they are refused with
// the same error a real user cancellation produces, so sites fall back to
// their password form instead of hanging.
const { contextBridge } = require('electron');

try {
  contextBridge.executeInMainWorld({
    func: () => {
      if (!window.navigator || !navigator.credentials) return;

      const refuse = (original) => function (options) {
        if (options && options.publicKey) {
          return Promise.reject(new DOMException(
            'Passkeys and security keys are turned off in this browser.',
            'NotAllowedError'));
        }
        return original.call(navigator.credentials, options);
      };

      navigator.credentials.get = refuse(navigator.credentials.get);
      navigator.credentials.create = refuse(navigator.credentials.create);

      // Sites feature-detect on this before they ever call the API, so
      // removing it is what actually stops most of them from trying.
      try { delete window.PublicKeyCredential; } catch (err) {}
    }
  });
} catch (err) {
  // An older Electron without executeInMainWorld. Better to load the page
  // than to fail it.
}
