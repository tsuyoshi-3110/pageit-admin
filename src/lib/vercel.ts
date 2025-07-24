// lib/vercel.ts
export async function deleteVercelProject(projectName: string) {
  const res = await fetch(`https://api.vercel.com/v9/projects/${projectName}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    console.error("Vercel delete error:", await res.text());
  }

  return res;
}
