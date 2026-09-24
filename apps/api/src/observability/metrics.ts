/**
 * Minimal metrics interface. The in-process implementation renders Prometheus text format at
 * GET /metrics. To adopt OpenTelemetry / Datadog later, implement `Metrics` against that SDK and
 * pass it to buildApp(); call sites do not change.
 */
export type Labels = Record<string, string | number>;

export interface Metrics {
  increment(name: string, labels?: Labels, value?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
  gauge(name: string, value: number, labels?: Labels): void;
  render(): string;
}

const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000];

function key(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`);
  return `${name}{${parts.join(",")}}`;
}

function withLabel(series: string, extra: string): string {
  return series.includes("{") ? series.replace("}", `,${extra}}`) : `${series}{${extra}}`;
}

interface Hist {
  buckets: number[];
  sum: number;
  count: number;
}

export class InMemoryMetrics implements Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private hists = new Map<string, Hist>();

  increment(name: string, labels?: Labels, value = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  gauge(name: string, value: number, labels?: Labels) {
    this.gauges.set(key(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels) {
    const k = key(name, labels);
    let h = this.hists.get(k);
    if (!h) {
      h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.hists.set(k, h);
    }
    BUCKETS.forEach((b, i) => {
      if (value <= b) h!.buckets[i]!++;
    });
    h.sum += value;
    h.count++;
  }

  /** Test helper. */
  counter(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const [k, h] of this.hists) {
      const base = k.split("{")[0]!;
      const labels = k.includes("{") ? k.slice(k.indexOf("{")) : "";
      BUCKETS.forEach((b, i) => lines.push(`${withLabel(`${base}_bucket${labels}`, `le="${b}"`)} ${h.buckets[i]}`));
      lines.push(`${withLabel(`${base}_bucket${labels}`, `le="+Inf"`)} ${h.count}`);
      lines.push(`${base}_sum${labels} ${h.sum}`);
      lines.push(`${base}_count${labels} ${h.count}`);
    }
    return lines.sort().join("\n") + "\n";
  }
}

export class NoopMetrics implements Metrics {
  increment() {}
  observe() {}
  gauge() {}
  render() {
    return "";
  }
}
