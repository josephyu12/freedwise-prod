import Link from 'next/link'

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
              About
            </h1>
            <Link
              href="/"
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition"
            >
              Back to Home
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg space-y-6">
            <div>
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                Project Philosophy
              </h2>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                This project was created with the belief that notes are only useful if often read, 
                and this way we can automatically distribute them across for easy daily review.
              </p>
            </div>

            <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
                Known Issues
              </h2>
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
                <p className="text-yellow-800 dark:text-yellow-200">
                  <strong>Noted errors:</strong> Highlights with bullet points are not recognized in the Notion page, 
                  so edits and deletions cannot find the right place to be completed. Use with caution when editing 
                  or deleting highlights that contain bullet points.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

