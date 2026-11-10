"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** While an order waits for the payment webhook, re-check it every couple of seconds. */
export default function PendingRefresh() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 1500);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
