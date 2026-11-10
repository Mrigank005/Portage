"use client";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

function Form() {
  const stripe = useStripe();
  const elements = useElements();
  return (
    <form onSubmit={async (e) => { e.preventDefault(); await stripe!.confirmPayment({ elements: elements!, confirmParams: { return_url: "/done" } }); }}>
      <PaymentElement />
      <button>Pay</button>
    </form>
  );
}

export default function CardForm({ clientSecret }: { clientSecret: string }) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <Form />
    </Elements>
  );
}
