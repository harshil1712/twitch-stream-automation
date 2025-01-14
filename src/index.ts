import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.post("/api/live-announcement", async (c) => {
  const data = await c.req.json();
  const TWITCH_API = `https://api.twitch.tv/helix/videos?user_id=${c.env.TWITCH_USER_ID}&first=2&sort=time&period=day`;
  if (data && data.challenge) {
    return c.text(data.challenge);
  }
  if (data && data.subscription.type === "stream.online") {
    const videoData = await fetch(TWITCH_API, {
      headers: {
        "Client-ID": `${c.env.TWITCH_CLIENT_ID}`,
        Authorization: `Bearer ${c.env.TWITCH_APP_ACCESS_TOKEN}`,
      },
    });
    if (videoData.ok) {
      const video = (await videoData.json()) as any;
      const title = video.data[0].title;
      // Deploy to Workers
      // Use Workers AI to generate social media posts
      // Use Workers AI to generate a video thumbnail for the stream
      // Share the posts on Social Media
      // stream down subscription: Store time_stamp, title, and video_id in D1
    }
    return c.text("I am liveeee");
  }
  return c.json({ data });
});

export default app;
