import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/stats/reviewed-count?month=YYYY-MM
 * Returns how many highlights were reviewed (marked in highlight_months_reviewed) for the given month.
 * Defaults to the previous calendar month if month is omitted.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    let monthYear = searchParams.get('month')
    if (!monthYear) {
      const now = new Date()
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      monthYear = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`
    }
    // Basic format check YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(monthYear)) {
      return NextResponse.json({ error: 'Invalid month; use YYYY-MM' }, { status: 400 })
    }

    const PAGE = 1000
    const userHighlightIds = new Set<string>()
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlights')
        .select('id')
        .eq('user_id', user.id)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ id: string }>
      page.forEach((r) => userHighlightIds.add(r.id))
      if (page.length < PAGE) break
      from += PAGE
    }

    let count = 0
    from = 0
    while (true) {
      const { data, error } = await supabase
        .from('highlight_months_reviewed')
        .select('highlight_id')
        .eq('month_year', monthYear)
        .range(from, from + PAGE - 1)
      if (error) throw error
      const page = (data || []) as Array<{ highlight_id: string }>
      count += page.filter((r) => userHighlightIds.has(r.highlight_id)).length
      if (page.length < PAGE) break
      from += PAGE
    }

    return NextResponse.json({ count, month: monthYear })
  } catch (error: any) {
    console.error('Error in reviewed-count:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to get reviewed count' },
      { status: 500 }
    )
  }
}
