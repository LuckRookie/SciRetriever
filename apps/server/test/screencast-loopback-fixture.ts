import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserHost } from "../src/browser/host.js";
import { verifyInstalledCloakRuntime } from "../src/configuration/cloak-runtime.js";
import { BrowserNetworkProxy } from "../src/network/browser-proxy.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";
import { resolveBrowserDestination } from "../src/network/policy.js";

export const SCREENCAST_TEST_PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:18px sans-serif}#target{position:fixed;left:20px;top:80px;width:140px;height:60px;background:#1355aa;color:white}input{position:fixed;left:20px;width:200px;height:40px;background:#ffff00;color:#000}#password{top:160px}#otp{top:220px}#text{top:280px;background:#fff}#popup{position:fixed;left:20px;top:340px;width:140px;height:50px}#bar{position:fixed;left:400px;top:100px;width:300px;height:100px;background:#eee}#drag{position:fixed;left:220px;top:340px;width:100px;height:50px;background:#879}#status{position:fixed;top:5px;left:20px}main{height:5000px;background:repeating-linear-gradient(white,#ccc 50px,white 100px)}
</style><main></main><p id="status">clicks 0; masks 0; keys 0; drag 0</p><button id="target">Click target</button><input id="password" type="password" value="synthetic"><input id="otp" autocomplete="one-time-code" value="123456"><input id="text"><button id="popup" onclick="window.open('/popup')">Popup</button><div id="drag"></div><canvas id="bar" width="300" height="100"></canvas>
<script>
const state={clicks:0,masks:0,keys:0,drag:0};
const status=document.getElementById('status'),target=document.getElementById('target'),bar=document.getElementById('bar'),ctx=bar.getContext('2d');
function update(){status.textContent='clicks '+state.clicks+'; masks '+state.masks+'; keys '+state.keys+'; drag '+state.drag;}
target.onclick=()=>{state.clicks++;target.style.background=state.clicks%2?'#14942a':'#1355aa';update();};
document.getElementById('text').oninput=()=>{state.keys++;update();};
document.getElementById('drag').onpointermove=e=>{if(e.buttons){state.drag++;update();}};
new MutationObserver(events=>{for(const e of events)if([...e.addedNodes].some(n=>n.nodeType===1 && (n.id==='playwright-mask-container'||n.tagName.includes('PLAYWRIGHT')))){state.masks++;update();}}).observe(document.documentElement,{childList:true,subtree:true});
let animate=false;
function draw(){ctx.fillStyle='#eee';ctx.fillRect(0,0,300,100);const n=BigInt(Date.now());for(let bit=0;bit<48;bit++){ctx.fillStyle=(n>>BigInt(bit))&1n?'#000':'#fff';ctx.fillRect(bit*6,0,6,40);}ctx.fillStyle='#000';ctx.font='20px sans-serif';ctx.fillText(String(n),10,80);}
function tick(){if(animate)draw();requestAnimationFrame(tick);}draw();tick();
window.fixture={setMode(mode){animate=mode==='animation';if(mode==='static')draw();},state};
</script>`;
export async function screencastLoopbackFixture(bundle: string) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-screencast-"));
  const site = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      SCREENCAST_TEST_PAGE +
        (_request.url === "/animation"
          ? '<script>window.fixture.setMode("animation")</script>'
          : ""),
    );
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("fixture");
  const origin = `http://127.0.0.1:${address.port}`;
  const budget = new NetworkBudgetCoordinator();
  let rejected = 0;
  const resolver = (hostname: string) => {
    if (hostname !== "127.0.0.1") {
      rejected++;
      throw new Error("loopback-only");
    }
    return ["127.0.0.1"];
  };
  const policy = {
    allowed_schemes: ["http"] as const,
    allowed_classes: ["loopback"] as const,
    allowed_addresses: ["127.0.0.1"],
    allowed_ports: [{ scheme: "http" as const, port: address.port }],
  };
  const proxy = new BrowserNetworkProxy({
    resolver,
    policy,
    coordinator: budget,
    limits: {
      maxConcurrency: 8,
      maxHostConcurrency: 8,
      maxResponseBytes: 4 * 1024 * 1024,
      maxRedirects: 0,
      maxRetries: 0,
    },
  });
  const host = new BrowserHost({
    runtime: await verifyInstalledCloakRuntime(bundle),
    profile: join(home, "profile"),
    proxy: await proxy.start(),
    admitNavigation: async (url) =>
      (await resolveBrowserDestination(url, resolver, policy)).url.url,
  });
  try {
    await host.start();
    const page = await host.openPage(origin + "/article");
    return {
      home,
      host,
      page,
      origin,
      rejected: () => rejected,
      close: async () => {
        await host.close();
        await proxy.close();
        budget.close();
        await new Promise<void>((resolve) => site.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host.close();
    await proxy.close();
    budget.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
