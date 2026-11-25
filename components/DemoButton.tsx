'use client'

import { useState } from 'react'
import { isAuthSessionMissingError } from '@supabase/supabase-js'
import { format } from 'date-fns'
import { clearOfflinePageData } from '@/lib/offlineStore'
import { createClient } from '@/lib/supabase/client'

type DemoButtonProps = {
  className: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
}

export default function DemoButton({ className, disabled, onPendingChange }: DemoButtonProps) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')

  const startDemo = async () => {
    setPending(true)
    onPendingChange?.(true)
    setMessage('')

    try {
      const supabase = createClient()
      const { data: { user }, error } = await supabase.auth.getUser()
      if (error && !isAuthSessionMissingError(error)) throw error

      if (user && !user.is_anonymous) {
        setMessage('You’re signed in. Open this page in a private window to try the demo.')
      } else {
        if (!user) {
          await clearOfflinePageData()
          const { error: demoAuthError } = await supabase.auth.signInAnonymously()
          if (demoAuthError) throw demoAuthError
        }

        const { error: seedError } = await (supabase.rpc as any)('seed_demo_workspace', {
          p_today: format(new Date(), 'yyyy-MM-dd'),
        })
        if (seedError) throw seedError

        window.location.assign('/review')
        return
      }
    } catch (error) {
      console.error('Could not start the demo:', error)
      setMessage('The demo could not start. Please try again in a moment.')
    }
    setPending(false)
    onPendingChange?.(false)
  }

  return (
    <div>
      <button
        type="button"
        onClick={startDemo}
        disabled={disabled || pending}
        className={className}
      >
        {pending ? 'Opening demo…' : 'Try the demo'}
      </button>
      {message && (
        <p role="alert" className="mx-auto mt-3 max-w-xs text-sm text-red-700 dark:text-red-300">
          {message}
        </p>
      )}
    </div>
  )
}
