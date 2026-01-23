export interface Category {
  id: string
  name: string
  color?: string
  created_at: string
}

export interface HighlightMonthReviewed {
  id: string
  highlight_id: string
  month_year: string // Format: "YYYY-MM" e.g., "2026-01"
  created_at: string
}

export interface Highlight {
  id: string
  text: string
  html_content?: string
  source?: string
  author?: string
  created_at: string
  last_resurfaced?: string
  resurface_count: number
  average_rating?: number
  rating_count?: number
  archived?: boolean
  categories?: Category[]
  linked_highlights?: HighlightLink[]
  months_reviewed?: HighlightMonthReviewed[]
}

export interface HighlightLink {
  id: string
  from_highlight_id: string
  to_highlight_id: string
  link_text?: string
  to_highlight?: Highlight
}

export interface DailySummaryHighlight {
  id: string
  daily_summary_id: string
  highlight_id: string
  rating?: 1 | 2 | 3 | 4 | 5 | null
  highlight?: Highlight
}

export interface DailySummary {
  id: string
  date: string
  highlights: DailySummaryHighlight[]
  created_at: string
}

// Database type for Supabase client
export type Database = {
  public: {
    Tables: {
      categories: {
        Row: {
          id: string
          name: string
          color: string | null
          created_at: string
          user_id: string | null
        }
        Insert: {
          id?: string
          name: string
          color?: string | null
          created_at?: string
          user_id?: string | null
        }
        Update: {
          id?: string
          name?: string
          color?: string | null
          created_at?: string
          user_id?: string | null
        }
      }
      highlights: {
        Row: {
          id: string
          text: string
          html_content: string | null
          source: string | null
          author: string | null
          created_at: string
          last_resurfaced: string | null
          resurface_count: number
          average_rating: number | null
          rating_count: number
          archived: boolean | null
          user_id: string | null
        }
        Insert: {
          id?: string
          text: string
          html_content?: string | null
          source?: string | null
          author?: string | null
          created_at?: string
          last_resurfaced?: string | null
          resurface_count?: number
          average_rating?: number | null
          rating_count?: number
          archived?: boolean | null
          user_id?: string | null
        }
        Update: {
          id?: string
          text?: string
          html_content?: string | null
          source?: string | null
          author?: string | null
          created_at?: string
          last_resurfaced?: string | null
          resurface_count?: number
          average_rating?: number | null
          rating_count?: number
          archived?: boolean | null
          user_id?: string | null
        }
      }
      daily_summaries: {
        Row: {
          id: string
          date: string
          created_at: string
          user_id: string | null
        }
        Insert: {
          id?: string
          date: string
          created_at?: string
          user_id?: string | null
        }
        Update: {
          id?: string
          date?: string
          created_at?: string
          user_id?: string | null
        }
      }
      highlight_categories: {
        Row: {
          id: string
          highlight_id: string
          category_id: string
          created_at: string
        }
        Insert: {
          id?: string
          highlight_id: string
          category_id: string
          created_at?: string
        }
        Update: {
          id?: string
          highlight_id?: string
          category_id?: string
          created_at?: string
        }
      }
      highlight_links: {
        Row: {
          id: string
          from_highlight_id: string
          to_highlight_id: string
          link_text: string | null
          created_at: string
        }
        Insert: {
          id?: string
          from_highlight_id: string
          to_highlight_id: string
          link_text?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          from_highlight_id?: string
          to_highlight_id?: string
          link_text?: string | null
          created_at?: string
        }
      }
      daily_summary_highlights: {
        Row: {
          id: string
          daily_summary_id: string
          highlight_id: string
          rating: 'low' | 'med' | 'high' | null
          created_at: string
        }
        Insert: {
          id?: string
          daily_summary_id: string
          highlight_id: string
          rating?: 'low' | 'med' | 'high' | null
          created_at?: string
        }
        Update: {
          id?: string
          daily_summary_id?: string
          highlight_id?: string
          rating?: 'low' | 'med' | 'high' | null
          created_at?: string
        }
      }
      highlight_months_reviewed: {
        Row: {
          id: string
          highlight_id: string
          month_year: string
          created_at: string
        }
        Insert: {
          id?: string
          highlight_id: string
          month_year: string
          created_at?: string
        }
        Update: {
          id?: string
          highlight_id?: string
          month_year?: string
          created_at?: string
        }
      }
      user_notion_settings: {
        Row: {
          id: string
          user_id: string
          notion_api_key: string
          notion_page_id: string
          enabled: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          notion_api_key: string
          notion_page_id: string
          enabled?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          notion_api_key?: string
          notion_page_id?: string
          enabled?: boolean
          created_at?: string
          updated_at?: string
        }
      }
      notion_sync_queue: {
        Row: {
          id: string
          user_id: string
          highlight_id: string | null // Nullable for delete operations
          operation_type: 'add' | 'update' | 'delete'
          text: string | null
          html_content: string | null
          original_text: string | null
          original_html_content: string | null
          status: 'pending' | 'processing' | 'completed' | 'failed'
          retry_count: number
          max_retries: number
          error_message: string | null
          last_retry_at: string | null
          next_retry_at: string | null
          created_at: string
          updated_at: string
          processed_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          highlight_id?: string | null // Nullable for delete operations
          operation_type: 'add' | 'update' | 'delete'
          text?: string | null
          html_content?: string | null
          original_text?: string | null
          original_html_content?: string | null
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          retry_count?: number
          max_retries?: number
          error_message?: string | null
          last_retry_at?: string | null
          next_retry_at?: string | null
          created_at?: string
          updated_at?: string
          processed_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          highlight_id?: string | null // Nullable for delete operations
          operation_type?: 'add' | 'update' | 'delete'
          text?: string | null
          html_content?: string | null
          original_text?: string | null
          original_html_content?: string | null
          status?: 'pending' | 'processing' | 'completed' | 'failed'
          retry_count?: number
          max_retries?: number
          error_message?: string | null
          last_retry_at?: string | null
          next_retry_at?: string | null
          created_at?: string
          updated_at?: string
          processed_at?: string | null
        }
      }
      pinned_highlights: {
        Row: {
          id: string
          user_id: string
          highlight_id: string
          pinned_at: string
        }
        Insert: {
          id?: string
          user_id: string
          highlight_id: string
          pinned_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          highlight_id?: string
          pinned_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}

