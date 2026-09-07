// Runs in every page, before that page's own scripts, when "Allow passkeys
// and security keys" is turned off.
//
// This has to be done carefully. Google's sign-in runs integrity checks on
// the page, and a browser that looks modified gets told it "may not be
// secure" and refused a login. So the two obvious implementations are both
// wrong: deleting window.PublicKeyCredential is a visible hole, and
// assigning a plain function over navigator.credentials.get gives it a
// toString() full of readable JavaScript instead of "[native code]".
//
// A Proxy avoids both. Function.prototype.toString on a proxy of a native
// function still reports native code, and the property keeps its identity,
// so the page sees the API it expects -- it just gets the same refusal a
// real person produces by dismissing the Windows dialog.
const { contextBridge } = require('electron');

try {
  contextBridge.executeInMainWorld({
    func: () => {
      if (!window.navigator || !navigator.credentials) return;

      const refuse = (original) => new Proxy(original, {
        apply(target, thisArg, args) {
          const options = args[0];
          // Only passkey and security-key requests. Password autofill and
          // federated sign-in go straight through.
          if (options && options.publicKey) {
            return Promise.reject(new DOMException(
              'The request is not allowed by the user agent.', 'NotAllowedError'));
          }
          return Reflect.apply(target, thisArg, args);
        }
      });

      try {
        navigator.credentials.get = refuse(navigator.credentials.get);
        navigator.credentials.create = refuse(navigator.credentials.create);
      } catch (err) {
        // Frozen or unusual page. Leave it alone rather than break it.
      }
    }
  });
} catch (err) {
  // An older Electron without executeInMainWorld. Better to load the page
  // than to fail it.
}
