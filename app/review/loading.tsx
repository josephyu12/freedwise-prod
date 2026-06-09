import Link from 'next/link'

// Route-level loading UI for /review. Next.js shows this instantly during a
// navigation to the segment — before the heavy /review client bundle has to
// download or mount — so the "switch to text-only" escape hatch is available at
// the earliest in-app moment, which matters most on a weak connection.
export default function Loading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 px-6">
      <div className="text-xl text-gray-600 dark:text-gray-300">Loading...</div>
      <Link href="/review/lite" className="text-sm text-blue-600 dark:text-blue-400 underline">
        Slow connection? Switch to text-only →
      </Link>
    </div>
  )
}
