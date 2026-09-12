import type { Page } from "playwright";
import { humanMove, humanClick, resolveConfig } from "cloakbrowser/human";

/** Every low-level event checks the live control lease, including after vendor delays. */
export class HumanizedBrowserInput {
  private x = 0;
  private y = 0;
  private readonly config = resolveConfig("default", { mistype_chance: 0 });
  constructor(private readonly page: Page) {}
  async click(x: number, y: number, check: () => void): Promise<void> {
    let down = false;
    const raw = {
      move: async (x: number, y: number) => {
        check();
        await this.page.mouse.move(x, y);
      },
      down: async () => {
        check();
        await this.page.mouse.down();
        down = true;
      },
      up: async () => {
        check();
        await this.page.mouse.up();
        down = false;
      },
      wheel: async (x: number, y: number) => {
        check();
        await this.page.mouse.wheel(x, y);
      },
    };
    try {
      await humanMove(raw, this.x, this.y, x, y, this.config);
      check();
      this.x = x;
      this.y = y;
      await humanClick(raw, false, this.config);
    } finally {
      if (down) await this.page.mouse.up();
    }
  }
  async scroll(x: number, y: number, check: () => void): Promise<void> {
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(x), Math.abs(y)) / 160),
    );
    for (let step = 0; step < steps; step++) {
      check();
      await this.page.mouse.wheel(x / steps, y / steps);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  async text(value: string, check: () => void): Promise<void> {
    for (const character of value) {
      check();
      await this.page.keyboard.insertText(character);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.config.typing_delay),
      );
    }
  }
  async key(value: string, check: () => void): Promise<void> {
    check();
    await this.page.keyboard.press(value, { delay: this.config.key_hold[0] });
  }
}
