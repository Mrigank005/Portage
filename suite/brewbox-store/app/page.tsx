import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function Home() {
  // The catalog lives in Stripe: products with their default price expanded.
  const products = await stripe.products.list({ active: true, limit: 20, expand: ["data.default_price"] });

  return (
    <>
      <h1>Beans and brewing gear</h1>
      <p className="lede">Small-batch coffee, shipped fresh. Pay by card at checkout.</p>
      <div className="grid">
        {products.data.map((product) => {
          const price = product.default_price as Stripe.Price | null;
          if (!price || price.unit_amount === null) return null;
          return (
            <article className="card" key={product.id}>
              <h2>{product.name}</h2>
              <p>{product.description}</p>
              <div className="price">{formatMoney(price.unit_amount, price.currency)}</div>
              <form className="buy" action="/api/checkout" method="post">
                <input type="hidden" name="priceId" value={price.id} />
                <select name="quantity" aria-label={`Quantity of ${product.name}`} defaultValue="1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <button className="primary" type="submit">
                  Buy now
                </button>
              </form>
            </article>
          );
        })}
      </div>
    </>
  );
}
