import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VideoMetrics {
  views: number;
  likes: number;
  subscribers: number;
  durationSec: number;
  uploadDate: string; // "YYYYMMDD"
  title: string;
}

export interface VideoScore {
  score: number;         // 0–5
  viewToSubRatio: number;
  likeRatio: number;
  breakdown: { factor: string; weight: number; value: number }[];
}

export function parseDuration(d: string): number {
  const parts = d.split(":").map(Number).reverse();
  let sec = 0;
  if (parts[0]) sec += parts[0];
  if (parts[1]) sec += parts[1] * 60;
  if (parts[2]) sec += parts[2] * 3600;
  return sec;
}

export function scoreVideo(m: VideoMetrics): VideoScore {
  const viewToSubRatio = m.subscribers > 0 ? m.views / m.subscribers : 0;
  const likeRatio = m.views > 0 ? m.likes / m.views : 0;

  // Normalize each to 0–5
  const viewScore = Math.min(5, viewToSubRatio / 2);      // 10× ratio = 5
  const likeScore = Math.min(5, likeRatio * 100);         // 5% likes = 5 (YouTube norm ~2–5%)
  const durationScore = m.durationSec >= 300 && m.durationSec <= 900 ? 5 : 2;

  const score = viewScore * 0.5 + likeScore * 0.3 + durationScore * 0.2;

  return {
    score: Math.round(score * 100) / 100,
    viewToSubRatio,
    likeRatio,
    breakdown: [
      { factor: "views:subs", weight: 0.5, value: viewScore },
      { factor: "like ratio", weight: 0.3, value: likeScore },
      { factor: "duration fit", weight: 0.2, value: durationScore },
    ],
  };
}

export function meetsQualityBar(m: VideoMetrics, today: Date): boolean {
  // Upload within last 6 months
  const uy = parseInt(m.uploadDate.slice(0, 4));
  const um = parseInt(m.uploadDate.slice(4, 6));
  const ud = parseInt(m.uploadDate.slice(6, 8));
  const uploaded = new Date(uy, um - 1, ud);
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  if (uploaded < sixMonthsAgo) return false;

  // 5–15 min
  if (m.durationSec < 300 || m.durationSec > 900) return false;

  // view:sub >= 5×
  if (m.subscribers > 0 && m.views / m.subscribers < 5) return false;

  // like ratio >= 0.9% (modern proxy for "90%+ likes" on old thumbs system)
  if (m.views > 0 && m.likes / m.views < 0.009) return false;

  return true;
}

export async function fetchMetrics(videoUrl: string): Promise<VideoMetrics> {
  const fmt = "%(view_count)s\t%(like_count)s\t%(channel_follower_count)s\t%(duration)s\t%(upload_date)s\t%(title)s";
  const { stdout } = await execFileAsync("yt-dlp", [
    "--print", fmt,
    "--skip-download",
    "--no-warnings",
    videoUrl,
  ], { timeout: 20_000 });
  const [views, likes, subs, dur, up, title] = stdout.trim().split("\t");
  return {
    views: parseInt(views, 10),
    likes: parseInt(likes, 10),
    subscribers: parseInt(subs, 10),
    durationSec: parseInt(dur, 10),
    uploadDate: up,
    title,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: brew-youtube-scorer <youtube-url>");
    process.exit(1);
  }
  fetchMetrics(url).then(m => {
    const s = scoreVideo(m);
    const passes = meetsQualityBar(m, new Date());
    console.log(JSON.stringify({ url, metrics: m, score: s, passes_bar: passes }, null, 2));
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
