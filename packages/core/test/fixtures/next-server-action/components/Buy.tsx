"use client";
import { startCheckout } from "@/app/actions/checkout";

export function Buy({ price }: { price: { id: string; type: "one_time" | "recurring" } }) {
  return <button onClick={async () => console.log(await startCheckout(price))}>Buy</button>;
}
