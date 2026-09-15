import Foundation
import Supabase

enum SupabaseConfig {
    static let url = URL(string: "https://mhcrfzznildwzopnveow.supabase.co")!
    static let publishableKey = "sb_publishable_6iBgGmUPGWk_OCoJ4PeS-A_2SIzzbxR"

    static let client = SupabaseClient(
        supabaseURL: url,
        supabaseKey: publishableKey
    )
}
