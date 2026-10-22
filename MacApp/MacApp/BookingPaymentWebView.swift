import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#endif

#if os(macOS)
private typealias PlatformViewRepresentable = NSViewRepresentable
#else
private typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Hosts Stripe.js Elements to confirm a PaymentIntent (publishable key only).
struct BookingPaymentWebView: PlatformViewRepresentable {
    let publishableKey: String
    let clientSecret: String
    let amountDisplay: String
    var onSuccess: (String) -> Void
    var onError: (String) -> Void

#if os(macOS)
    func makeNSView(context: Context) -> WKWebView {
        makeWebView(context: context)
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
#else
    func makeUIView(context: Context) -> WKWebView {
        makeWebView(context: context)
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
#endif

    func makeCoordinator() -> Coordinator {
        Coordinator(onSuccess: onSuccess, onError: onError)
    }

    private func makeWebView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "vroomkBooking")
        let webView = WKWebView(frame: .zero, configuration: config)
#if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
#else
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
#endif
        webView.loadHTMLString(
            Self.html(
                publishableKey: publishableKey,
                clientSecret: clientSecret,
                amountDisplay: amountDisplay
            ),
            baseURL: URL(string: "https://www.vroomk.com")
        )
        return webView
    }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let onSuccess: (String) -> Void
        let onError: (String) -> Void

        init(onSuccess: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onSuccess = onSuccess
            self.onError = onError
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String
            else { return }

            DispatchQueue.main.async {
                switch type {
                case "success":
                    let id = (body["paymentIntentId"] as? String) ?? ""
                    self.onSuccess(id)
                case "error":
                    let msg = (body["message"] as? String) ?? "Payment failed."
                    self.onError(msg)
                default:
                    break
                }
            }
        }
    }

    private static func html(
        publishableKey: String,
        clientSecret: String,
        amountDisplay: String
    ) -> String {
        let pk = escapeJS(publishableKey)
        let secret = escapeJS(clientSecret)
        let amount = escapeHTML(amountDisplay)
        return """
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <script src="https://js.stripe.com/v3/"></script>
          <style>
            :root { color-scheme: dark; }
            * { box-sizing: border-box; }
            body {
              margin: 0; padding: 16px;
              font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
              background: transparent; color: rgba(255,255,255,0.9);
            }
            h2 { font-weight: 500; font-size: 16px; margin: 0 0 6px; }
            p { margin: 0 0 16px; font-size: 13px; color: rgba(255,255,255,0.45); }
            #card-element {
              padding: 14px 12px;
              border-radius: 10px;
              background: rgba(255,255,255,0.06);
              border: 1px solid rgba(255,255,255,0.12);
            }
            #pay {
              margin-top: 16px; width: 100%; height: 40px;
              border: none; border-radius: 999px; cursor: pointer;
              background: rgba(255,255,255,0.12);
              color: white; font-size: 14px; font-weight: 500;
            }
            #pay:disabled { opacity: 0.5; cursor: default; }
            #error { margin-top: 12px; color: #f28c85; font-size: 13px; min-height: 18px; }
          </style>
        </head>
        <body>
          <h2>Pay \(amount) advance</h2>
          <p>Secure card payment for your on-site scan booking.</p>
          <div id="card-element"></div>
          <button id="pay" type="button">Pay \(amount)</button>
          <div id="error"></div>
          <script>
            const stripe = Stripe("\(pk)");
            const elements = stripe.elements();
            const card = elements.create("card", {
              hidePostalCode: true,
              style: {
                base: {
                  color: "#ffffff",
                  fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
                  fontSize: "15px",
                  "::placeholder": { color: "rgba(255,255,255,0.35)" }
                },
                invalid: { color: "#f28c85" }
              }
            });
            card.mount("#card-element");
            const payBtn = document.getElementById("pay");
            const errorEl = document.getElementById("error");
            function post(payload) {
              window.webkit.messageHandlers.vroomkBooking.postMessage(payload);
            }
            payBtn.addEventListener("click", async () => {
              errorEl.textContent = "";
              payBtn.disabled = true;
              payBtn.textContent = "Processing…";
              try {
                const result = await stripe.confirmCardPayment("\(secret)", {
                  payment_method: { card: card }
                });
                if (result.error) {
                  errorEl.textContent = result.error.message || "Payment failed.";
                  post({ type: "error", message: result.error.message || "Payment failed." });
                  payBtn.disabled = false;
                  payBtn.textContent = "Pay \(amount)";
                  return;
                }
                const pi = result.paymentIntent;
                if (pi && pi.status === "succeeded") {
                  post({ type: "success", paymentIntentId: pi.id });
                  payBtn.textContent = "Paid";
                } else {
                  const msg = "Payment was not completed.";
                  errorEl.textContent = msg;
                  post({ type: "error", message: msg });
                  payBtn.disabled = false;
                  payBtn.textContent = "Pay \(amount)";
                }
              } catch (e) {
                const msg = (e && e.message) ? e.message : "Payment failed.";
                errorEl.textContent = msg;
                post({ type: "error", message: msg });
                payBtn.disabled = false;
                payBtn.textContent = "Pay \(amount)";
              }
            });
          </script>
        </body>
        </html>
        """
    }

    private static func escapeJS(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    private static func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
