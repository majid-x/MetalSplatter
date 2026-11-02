import { createClient } from '@supabase/supabase-js'
import { supabaseConfig } from './config'

const fileStorage = {
  getItem: (key: string) => window.avgs.authStorage.get(key),
  setItem: (key: string, value: string) => window.avgs.authStorage.set(key, value),
  removeItem: (key: string) => window.avgs.authStorage.remove(key)
}

export const supabase = createClient(supabaseConfig.url, supabaseConfig.publishableKey, {
  auth: {
    storage: fileStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
})
