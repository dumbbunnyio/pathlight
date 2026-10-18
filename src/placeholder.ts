import { NativeSession, Renderable, RGBA, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";

// Ordered coordinates from https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders.
const marks = `0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357
035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484
0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1
05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658
0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2
06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743
0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819
081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C
082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76
1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0
1CD1 1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC
1DD1 1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0
1DE1 1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1
20E7 20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9
2DEA 2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9
2DFA 2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4
A8E5 A8E6 A8E7 A8E8 A8E9 A8EA A8EB A8EC A8ED A8EE A8EF A8F0 A8F1 AAB0 AAB2 AAB3
AAB7 AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 FE24 FE25 FE26 10A0F 10A38 1D185 1D186
1D187 1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244`
  .split(/\s+/).map(hex => String.fromCodePoint(parseInt(hex, 16)));

export class PlaceholderRenderable extends Renderable {
  readonly effectiveProtocol = "kitty-unicode";
  readonly loadPromise: Promise<void>;
  loadError: unknown;
  private readonly lowId = randomInt(200, 256);
  private readonly highId = randomInt(1, 256);
  private readonly imageId = this.lowId + this.highId * 0x1000000;
  private readonly foreground = RGBA.fromIndex(this.lowId);
  private aspect = 1;
  private grid = "";
  private state: "loading" | "ready" | "closing" = "loading";

  constructor(ctx: RenderContext, private readonly session: NativeSession, private readonly inTmux: boolean, source: string) {
    super(ctx, { flexShrink: 0 });
    this.loadPromise = this.upload(source).catch(error => { this.loadError = error; });
  }

  private frame(control: string, payload = "") {
    const frame = `\x1b_G${control};${payload}\x1b\\`;
    return Buffer.from(this.inTmux ? `\x1bPtmux;${frame.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : frame);
  }

  private async upload(source: string) {
    const png = await readFile(source);
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Unicode image rendering requires a PNG.");
    }
    this.aspect = png.readUInt32BE(16) / png.readUInt32BE(20);
    if (!Number.isFinite(this.aspect) || this.aspect <= 0) throw new Error("Invalid PNG dimensions.");
    const encoded = png.toString("base64");
    for (let offset = 0; offset < encoded.length; offset += 4096) {
      if (this.state === "closing") return;
      const frame = this.frame(`${offset === 0 ? `a=t,f=100,i=${this.imageId},q=2,` : ""}m=${Number(offset + 4096 < encoded.length)}`, encoded.slice(offset, offset + 4096));
      while (!this.session.write(frame)) {
        await this.session.idle();
        if (this.closing()) return;
      }
    }
    await this.session.idle();
    if (!this.closing()) this.state = "ready";
  }

  fit(columns: number, rows: number, zoom: number, cellAspect: number) {
    const ratio = this.aspect / cellAspect;
    const height = Math.max(1, Math.min(rows, columns / ratio));
    const scale = Math.min(zoom, marks.length / height, marks.length / (height * ratio));
    this.width = Math.max(1, Math.floor(height * ratio * scale));
    this.height = Math.max(1, Math.floor(height * scale));
    return scale;
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    if (this.state !== "ready") return;
    const grid = `${this.width},${this.height}`;
    if (grid !== this.grid) {
      if (!this.session.write(this.frame(`a=p,U=1,i=${this.imageId},p=1,c=${this.width},r=${this.height},q=2`))) {
        this.requestRender();
        return;
      }
      this.grid = grid;
    }
    for (let row = 0; row < this.height; row++) {
      let text = "";
      for (let column = 0; column < this.width; column++) text += `\u{10eeee}${marks[row]}${marks[column]}${marks[this.highId]}`;
      buffer.drawText(text, this.x, this.y + row, this.foreground);
    }
  }

  private closing() {
    return this.state === "closing";
  }

  async release() {
    this.state = "closing";
    await this.loadPromise;
    const deletion = this.frame(`a=d,d=I,i=${this.imageId},q=2`);
    while (!this.session.write(deletion)) await this.session.idle();
    await this.session.idle();
  }
}
