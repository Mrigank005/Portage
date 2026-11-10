// Portage reference: PayPal buttons on a server-rendered page (Express, plain HTML), using PayPal's JS SDK v6 with
// no build step. This follows PayPal's recommended v6 one-time payment sample.
//
// On the page:
//   <meta name="paypal-checkout" data-client-id="PUBLIC_CLIENT_ID" data-currency="USD"
//         data-create-url="/paypal/orders" data-capture-url="/paypal/orders/{orderId}/capture">
//   <paypal-button type="pay" class="paypal-gold" data-form="ID_OF_THE_EXISTING_CHECKOUT_FORM" hidden></paypal-button>
//   <script src="/paypal-buttons.js"></script>
//   <script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" onload="portagePayPalReady()"></script>
// (Use https://www.paypal.com/web-sdk/v6/core in production.)
//
// Each button sends the fields of its form to the create-order route, which answers { orderId }. After the buyer
// approves, the capture route answers { redirectUrl }. The server decides the amount, never the browser.
(function () {
  "use strict";

  function showError(button, message) {
    var note = button.nextElementSibling;
    if (!note || !note.classList || !note.classList.contains("paypal-error")) {
      note = document.createElement("p");
      note.className = "paypal-error";
      note.setAttribute("role", "alert");
      button.insertAdjacentElement("afterend", note);
    }
    note.textContent = message || "";
    note.hidden = !message;
  }

  function fieldsOf(button) {
    var fields = {};
    var form = button.dataset.form ? document.getElementById(button.dataset.form) : null;
    if (form) {
      new FormData(form).forEach(function (value, key) {
        if (typeof value === "string") fields[key] = value;
      });
    }
    return fields;
  }

  async function createOrder(button, createUrl) {
    showError(button, "");
    var res = await fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fieldsOf(button)) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.orderId) {
      var message = data.error || "PayPal checkout is unavailable right now.";
      showError(button, message);
      throw new Error(message);
    }
    return { orderId: data.orderId };
  }

  async function setup() {
    var config = document.querySelector('meta[name="paypal-checkout"]');
    if (!config || !window.paypal || !config.dataset.clientId) return;
    var createUrl = config.dataset.createUrl;
    var captureUrl = config.dataset.captureUrl;

    var sdk = await window.paypal.createInstance({ clientId: config.dataset.clientId, components: ["paypal-payments"], pageType: "checkout" });
    var methods = await sdk.findEligibleMethods({ currencyCode: config.dataset.currency || "USD" });
    if (!methods.isEligible("paypal")) return;

    document.querySelectorAll("paypal-button[data-form]").forEach(function (button) {
      var session = sdk.createPayPalOneTimePaymentSession({
        onApprove: async function (data) {
          var res = await fetch(captureUrl.replace("{orderId}", encodeURIComponent(data.orderId)), { method: "POST" });
          var result = await res.json().catch(function () { return {}; });
          if (res.ok && result.redirectUrl) window.location.assign(result.redirectUrl);
          else showError(button, result.error || "The payment could not be completed. You have not been charged.");
        },
        onCancel: function () { showError(button, ""); },
        onError: function () { showError(button, "PayPal ran into a problem. Please try again."); },
      });
      button.removeAttribute("hidden");
      button.addEventListener("click", async function () {
        try {
          // Pass the promise without awaiting it first: awaiting before start() loses the click's popup permission.
          await session.start({ presentationMode: "auto" }, createOrder(button, createUrl));
        } catch (err) {
          if (!button.nextElementSibling || button.nextElementSibling.hidden) showError(button, "PayPal checkout could not start.");
          console.error(err);
        }
      });
    });
  }

  window.portagePayPalReady = function () {
    setup().catch(function (err) { console.error("PayPal buttons could not load", err); });
  };
})();
