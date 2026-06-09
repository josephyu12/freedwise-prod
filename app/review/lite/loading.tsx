// Minimal loading UI for the text-only page. Overrides the parent
// app/review/loading.tsx so the lite route doesn't show a "switch to text-only"
// link while it's already loading text-only.
export default function Loading() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-6">
      <div className="text-gray-500 dark:text-gray-400">Loading…</div>
    </main>
  )
}
