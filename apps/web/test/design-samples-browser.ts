import type { Page, Response } from "playwright";

/** A renderer must outlive its real pagehide disconnect and server receipt. */
export function designSamplePageCleanup(page: Page): () => Promise<void> {
  let attached = false;
  const observe = (response: Response) => {
    if (
      new URL(response.url()).pathname === "/api/clients" &&
      response.request().method() === "POST" &&
      response.status() === 201
    )
      attached = true;
  };
  page.on("response", observe);
  return async () => {
    try {
      if (attached && !page.isClosed()) {
        const [response] = await Promise.all([
          page.waitForResponse(
            (value) =>
              new URL(value.url()).pathname === "/api/clients/disconnect" &&
              value.request().method() === "POST",
          ),
          page.evaluate(() =>
            window.dispatchEvent(new PageTransitionEvent("pagehide")),
          ),
        ]);
        // This endpoint sends 200 only after detach. Keepalive bodies can remain
        // unavailable to Playwright until renderer destruction; headers are the receipt.
        if (response.status() !== 200)
          throw new Error("Design sample disconnect was not acknowledged");
      }
    } finally {
      page.off("response", observe);
      await page.close();
    }
  };
}
