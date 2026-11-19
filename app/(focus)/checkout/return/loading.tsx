/** Shown straight away while the return page verifies the payment with Flutterwave. */
export default function ConfirmingPayment() {
  return (
    <div className="result" role="status" aria-live="polite">
      <div className="result-icon result-icon-pending" aria-hidden="true">
        <svg viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" className="result-ring" />
          <path d="M24 15v9l6 4" className="result-glyph" />
        </svg>
      </div>
      <h1 className="result-title">Confirming your payment…</h1>
      <p className="result-body">We&rsquo;re checking with Flutterwave. This usually takes a few seconds. Please keep this page open.</p>
      <span className="spinner spinner-lg" aria-hidden="true" />
    </div>
  );
}
