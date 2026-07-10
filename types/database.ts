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
  rating?: 'low' | 'med' | 'high' | null
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
          user_id: string
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
          user_id: string
          imported_from_notion: boolean
          notion_optout_marker: string | null
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
          imported_from_notion?: boolean
          notion_optout_marker?: string | null
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
          imported_from_notion?: boolean
          notion_optout_marker?: string | null
        }
      }
      daily_summaries: {
        Row: {
          id: string
          date: string
          created_at: string
          user_id: string
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
      user_review_settings: {
        Row: {
          user_id: string
          frequency_months: number
          daily_review_enabled: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          user_id: string
          frequency_months?: number
          daily_review_enabled?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          user_id?: string
          frequency_months?: number
          daily_review_enabled?: boolean
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
      review_ahead_order: {
        Row: {
          user_id: string
          cycle_key: string
          ids: string[]
          updated_at: string
        }
        Insert: {
          user_id: string
          cycle_key: string
          ids: string[]
          updated_at?: string
        }
        Update: {
          user_id?: string
          cycle_key?: string
          ids?: string[]
          updated_at?: string
        }
      }
      user_widget_settings: {
        Row: {
          user_id: string
          token_version: number
          created_at: string
          updated_at: string
        }
        Insert: {
          user_id: string
          token_version?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          user_id?: string
          token_version?: number
          created_at?: string
          updated_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      // Write-phase scheduling RPCs (see supabase/migration_schedule_rpcs.sql).
      // Bucket shape: [{ date: 'YYYY-MM-DD', highlight_ids: string[] }];
      // ledger shape: [{ month_year: 'YYYY-MM', highlight_ids: string[] }].
      place_assignments: {
        Args: { p_buckets: unknown }
        Returns: undefined
      }
      retile_schedule: {
        Args: { p_frequency: number; p_ledgers: unknown; p_buckets: unknown }
        Returns: undefined
      }
      assign_cycle_layout: {
        Args: { p_cycle_start: string; p_cycle_end: string; p_buckets: unknown }
        Returns: undefined
      }
      reset_cycle: {
        Args: { p_cycle_start: string; p_cycle_end: string; p_cycle_key: string }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
  }
}

