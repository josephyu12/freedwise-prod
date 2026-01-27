import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Extended stop words list
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
  'other', 'another', 'some', 'any', 'no', 'not', 'only', 'just', 'more', 'most',
  'very', 'too', 'so', 'than', 'then', 'there', 'their', 'them', 'these', 'those',
  'about', 'into', 'through', 'during', 'including', 'against', 'among', 'throughout',
  'despite', 'towards', 'upon', 'concerning', 'to', 'of', 'in', 'for', 'on', 'with',
  'at', 'by', 'from', 'up', 'about', 'into', 'through', 'during', 'including'
])

// Simple stemming - reduce words to root form
function stem(word: string): string {
  // Remove common suffixes
  if (word.length > 4) {
    if (word.endsWith('ing')) return word.slice(0, -3)
    if (word.endsWith('ed')) return word.slice(0, -2)
    if (word.endsWith('ly')) return word.slice(0, -2)
    if (word.endsWith('er')) return word.slice(0, -2)
    if (word.endsWith('est')) return word.slice(0, -3)
    if (word.endsWith('tion')) return word.slice(0, -4)
    if (word.endsWith('sion')) return word.slice(0, -4)
    if (word.endsWith('ness')) return word.slice(0, -4)
    if (word.endsWith('ment')) return word.slice(0, -4)
    if (word.endsWith('able')) return word.slice(0, -4)
    if (word.endsWith('ible')) return word.slice(0, -4)
  }
  // Remove plural 's'
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1)
  }
  return word
}

// Extract and normalize words from text
function extractWords(text: string): string[] {
  // Remove HTML tags
  const plainText = text.replace(/<[^>]*>/g, ' ').toLowerCase()
  
  // Extract words (alphanumeric sequences, including hyphens)
  const words = plainText.match(/\b[a-z]+(?:-[a-z]+)*\b/gi) || []
  
  // Filter, stem, and return words
  return words
    .map(word => word.toLowerCase())
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .map(word => stem(word))
}

// Calculate term frequency (TF) for a document
function calculateTF(words: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  const totalWords = words.length
  
  if (totalWords === 0) return tf
  
  for (const word of words) {
    tf.set(word, (tf.get(word) || 0) + 1 / totalWords)
  }
  
  return tf
}

// Calculate inverse document frequency (IDF) across all documents
function calculateIDF(allDocuments: string[][]): Map<string, number> {
  const idf = new Map<string, number>()
  const totalDocs = allDocuments.length
  
  if (totalDocs === 0) return idf
  
  // Count how many documents contain each word
  const wordDocCount = new Map<string, number>()
  
  for (const docWords of allDocuments) {
    const uniqueWords = new Set(docWords)
    for (const word of uniqueWords) {
      wordDocCount.set(word, (wordDocCount.get(word) || 0) + 1)
    }
  }
  
  // Calculate IDF: log(total_docs / docs_with_word)
  for (const [word, count] of wordDocCount.entries()) {
    idf.set(word, Math.log(totalDocs / count))
  }
  
  return idf
}

// Calculate TF-IDF vector for a document
function calculateTFIDF(words: string[], idf: Map<string, number>): Map<string, number> {
  const tf = calculateTF(words)
  const tfidf = new Map<string, number>()
  
  for (const [word, tfValue] of tf.entries()) {
    const idfValue = idf.get(word) || 0
    tfidf.set(word, tfValue * idfValue)
  }
  
  return tfidf
}

// Calculate cosine similarity between two TF-IDF vectors
function cosineSimilarity(
  vector1: Map<string, number>,
  vector2: Map<string, number>
): number {
  // Get all unique words from both vectors
  const allWords = new Set([...vector1.keys(), ...vector2.keys()])
  
  if (allWords.size === 0) return 0
  
  // Calculate dot product and magnitudes
  let dotProduct = 0
  let magnitude1 = 0
  let magnitude2 = 0
  
  for (const word of allWords) {
    const val1 = vector1.get(word) || 0
    const val2 = vector2.get(word) || 0
    
    dotProduct += val1 * val2
    magnitude1 += val1 * val1
    magnitude2 += val2 * val2
  }
  
  const magnitude = Math.sqrt(magnitude1) * Math.sqrt(magnitude2)
  
  if (magnitude === 0) return 0
  
  return dotProduct / magnitude
}

// Calculate similarity between two texts using TF-IDF and cosine similarity
function calculateSimilarity(text1: string, text2: string, idf?: Map<string, number>): number {
  const words1 = extractWords(text1)
  const words2 = extractWords(text2)
  
  if (words1.length === 0 || words2.length === 0) return 0
  
  // If IDF is provided (for batch processing), use it; otherwise calculate simple TF-IDF
  let vector1: Map<string, number>
  let vector2: Map<string, number>
  
  if (idf) {
    vector1 = calculateTFIDF(words1, idf)
    vector2 = calculateTFIDF(words2, idf)
  } else {
    // Simple approach: use both documents to calculate IDF
    const idfLocal = calculateIDF([words1, words2])
    vector1 = calculateTFIDF(words1, idfLocal)
    vector2 = calculateTFIDF(words2, idfLocal)
  }
  
  return cosineSimilarity(vector1, vector2)
}

// Enrich highlight with current month's assigned_date (for "Review on" tags). Uses server's now so it updates when month rolls over.
function enrichWithAssignedDate(h: any): any {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  const currentMonthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const currentMonthEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`
  let assigned_date: string | null = null
  if (h.daily_assignments && Array.isArray(h.daily_assignments) && h.daily_assignments.length > 0) {
    const currentMonthAssignment = h.daily_assignments.find((da: any) => {
      const d = da.daily_summary?.date
      if (!d) return false
      return d >= currentMonthStart && d <= currentMonthEnd
    })
    if (currentMonthAssignment?.daily_summary?.date) {
      assigned_date = currentMonthAssignment.daily_summary.date
    }
  }
  const { daily_assignments, ...rest } = h
  return { ...rest, assigned_date }
}

const dailyAssignmentsSelect = 'daily_assignments:daily_summary_highlights(id,daily_summary:daily_summaries(id,date))'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { query, type } = await request.json()

    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    const searchType = type || 'fulltext'

    if (searchType === 'fulltext') {
      // Full-text search using PostgreSQL's text search
      // We'll use ILIKE for pattern matching (can be enhanced with tsvector/tsquery for better performance)
      const { data: highlights, error } = await supabase
        .from('highlights')
        .select(`
          *,
          highlight_categories (
            category:categories (*)
          ),
          highlight_links_from:highlight_links!from_highlight_id (
            id,
            to_highlight_id,
            link_text,
            to_highlight:highlights!to_highlight_id (
              id,
              text,
              source,
              author
            )
          ),
          ${dailyAssignmentsSelect}
        `)
        .or(`text.ilike.%${query}%,html_content.ilike.%${query}%`)
        .eq('archived', false)
        .order('created_at', { ascending: false })
        .limit(50)

      if (error) throw error

      const processedHighlights = (highlights || []).map((h: any) =>
        enrichWithAssignedDate({
          ...h,
          categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: h.highlight_links_from || [],
        })
      )

      // For full-text search, also find similar highlights using TF-IDF
      const similar: any[] = []

      // Get all highlights to calculate similarity with proper IDF
      const { data: allHighlightsData } = await supabase
        .from('highlights')
        .select('id, text, html_content')
        .eq('archived', false)
        .limit(1000) // Limit for performance

      const allHighlights = (allHighlightsData || []) as Array<{ id: string; text: string; html_content: string | null }>

      if (allHighlights && allHighlights.length > 0) {
        // Pre-calculate IDF across all documents for better accuracy
        const allDocumentWords = allHighlights.map(h => 
          extractWords(h.html_content || h.text)
        )
        const queryWords = extractWords(query)
        const idf = calculateIDF([queryWords, ...allDocumentWords])
        
        // Calculate similarity scores using TF-IDF
        const similarities = allHighlights
          .map((h) => ({
            ...h,
            similarity: calculateSimilarity(
              query,
              h.html_content || h.text,
              idf
            ),
          }))
          .filter((h) => h.similarity > 0.15) // Higher threshold for better relevance
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 10) // Top 10 similar

        // Fetch full details for similar highlights
        if (similarities.length > 0) {
          const similarIds = similarities.map((s) => s.id)
          const { data: similarHighlights } = await supabase
            .from('highlights')
            .select(`
              *,
              highlight_categories (
                category:categories (*)
              ),
              ${dailyAssignmentsSelect}
            `)
            .in('id', similarIds)
            .eq('archived', false)

          if (similarHighlights) {
            // Preserve similarity order
            const similarMap = new Map(similarHighlights.map((h: any) => [h.id, h]))
            similar.push(...similarities.map((s) => {
              const h = similarMap.get(s.id)
              return enrichWithAssignedDate({
                ...h,
                similarity: s.similarity,
                categories: h?.highlight_categories?.map((hc: any) => hc.category) || [],
              })
            }))
          }
        }
      }

      return NextResponse.json({
        results: processedHighlights,
        similar: similar.filter((h) => !processedHighlights.some((r: any) => r.id === h.id)),
      })
    } else {
      // Semantic search using TF-IDF and cosine similarity
      const queryWords = extractWords(query)

      if (queryWords.length === 0) {
        return NextResponse.json({
          results: [],
          similar: [],
        })
      }

      // Get all highlights to calculate similarity
      const { data: allHighlightsData } = await supabase
        .from('highlights')
        .select(`
          *,
          highlight_categories (
            category:categories (*)
          ),
          highlight_links_from:highlight_links!from_highlight_id (
            id,
            to_highlight_id,
            link_text,
            to_highlight:highlights!to_highlight_id (
              id,
              text,
              source,
              author
            )
          ),
          ${dailyAssignmentsSelect}
        `)
        .eq('archived', false)
        .limit(1000) // Limit for performance

      const allHighlights = (allHighlightsData || []) as any[]

      if (!allHighlights || allHighlights.length === 0) {
        return NextResponse.json({
          results: [],
          similar: [],
        })
      }

      // Pre-calculate IDF across all documents for better accuracy
      const allDocumentWords = allHighlights.map((h: any) => 
        extractWords(h.html_content || h.text)
      )
      const idf = calculateIDF([queryWords, ...allDocumentWords])

      // Calculate similarity scores using TF-IDF
      const withSimilarity = allHighlights
        .map((h: any) => ({
          ...h,
          similarity: calculateSimilarity(
            query,
            h.html_content || h.text,
            idf
          ),
        }))
        .filter((h) => h.similarity > 0.15) // Higher threshold for better relevance
        .sort((a, b) => b.similarity - a.similarity)

      // Split into results (top matches) and similar (others); attach current-month assigned_date
      const results = withSimilarity.slice(0, 20).map((h: any) =>
        enrichWithAssignedDate({
          ...h,
          categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: h.highlight_links_from || [],
        })
      )

      const similar = withSimilarity.slice(20, 30).map((h: any) =>
        enrichWithAssignedDate({
          ...h,
          categories: h.highlight_categories?.map((hc: any) => hc.category) || [],
          linked_highlights: h.highlight_links_from || [],
        })
      )

      return NextResponse.json({
        results,
        similar,
      })
    }
  } catch (error: any) {
    console.error('Error performing search:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to perform search' },
      { status: 500 }
    )
  }
}

