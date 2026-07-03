// ╔══════════════════════════════════════════════════════════════════════════╗
// ║                                                                          ║
// ║   TISM_DB.JS — Supabase Client Layer for TISM v2                         ║
// ║   Hyperion Labs LLC                                                      ║
// ║                                                                          ║
// ║   This file is the ONLY place TISM talks to the database. Every other   ║
// ║   piece of code (Zeus, Hermes, Apollo, Athena, the UI) calls into       ║
// ║   functions defined here. If you ever need to swap databases, this is   ║
// ║   the only file that changes.                                            ║
// ║                                                                          ║
// ║   ARCHITECTURE:                                                          ║
// ║     window.TISM_DB = {                                                   ║
// ║       auth:      { login, logout, currentUser, onAuthChange }            ║
// ║       briefs:    { create, list, get, approve, reject, archive }         ║
// ║       copy:      { create, list, get, approve, reject, retire }          ║
// ║       designs:   { create, list, get, approve, reject, retire }          ║
// ║       campaigns: { create, list, get, updateStatus, recordMetrics }      ║
// ║       principles:{ list, propose, ratify, deprecate }                    ║
// ║       runs:      { log, listForAgent, recordOutcome }                    ║
// ║       lineage:   { ofCampaign, ofBrief }                                 ║
// ║     }                                                                    ║
// ║                                                                          ║
// ║   USAGE EXAMPLE:                                                         ║
// ║     await TISM_DB.briefs.create({ title, topic, handoff_packet });       ║
// ║     const briefs = await TISM_DB.briefs.list({ status: 'approved' });    ║
// ║                                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
// ⚠️  PASTE YOUR SUPABASE CREDENTIALS HERE.
// The publishable key is safe to embed in frontend code BECAUSE of the RLS
// policies we set up — anonymous users cannot read or write anything, only
// authenticated users can.
//
// To find these values:
//   Supabase Dashboard → your project → Settings → API
//
// ⚠️  NEVER paste the `secret` key here. That bypasses RLS.

const SUPABASE_URL = 'https://qssbdbqvokxefutdelys.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_vW31Q8S9BVCcgQ1_rXW0JA_t0TMAOUT';

// ─── INITIALIZATION ─────────────────────────────────────────────────────────
// We use Supabase's official JS SDK loaded from their CDN. The TISM HTML file
// must include this script tag before tism_db.js:
//
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

if (typeof window === 'undefined' || !window.supabase) {
  console.error('[TISM_DB] Supabase SDK not loaded. Add the CDN script tag to TISM HTML before tism_db.js.');
}

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,     // remember login across page reloads
    autoRefreshToken: true,   // refresh the auth token silently as needed
    detectSessionInUrl: false // we're not using magic-link/OAuth callbacks yet
  }
});

// ─── INTERNAL HELPERS ───────────────────────────────────────────────────────

/** Throws if not authenticated. Use at the top of every DB operation. */
async function _requireAuth() {
  const { data: { session }, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error('[TISM_DB] Auth check failed: ' + error.message);
  if (!session) throw new Error('[TISM_DB] Not authenticated. Please log in.');
  return session;
}

/** Wraps any Supabase response, throws on error, returns data. */
function _unwrap(response, context) {
  if (response.error) {
    console.error(`[TISM_DB ${context}]`, response.error);
    throw new Error(`[TISM_DB ${context}] ${response.error.message}`);
  }
  return response.data;
}

/** Returns the authenticated user's email (used as "approved_by" etc.). */
async function _whoAmI() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  return user?.email || 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════
//   AUTH MODULE
// ═══════════════════════════════════════════════════════════════════════════
const auth = {
  /** Email + password login. Returns the session on success. */
  async login(email, password) {
    const response = await supabaseClient.auth.signInWithPassword({ email, password });
    return _unwrap(response, 'auth.login');
  },

  /** Logs out and clears the local session. */
  async logout() {
    const response = await supabaseClient.auth.signOut();
    if (response.error) throw new Error(response.error.message);
    return true;
  },

  /** Returns the current user object (or null if logged out). */
  async currentUser() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    return user;
  },

  /** Returns the current session (or null if logged out). */
  async currentSession() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    return session;
  },

  /** Subscribe to login/logout events. Callback receives (event, session). */
  onAuthChange(callback) {
    return supabaseClient.auth.onAuthStateChange(callback);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   BRIEFS MODULE (Zeus's output)
// ═══════════════════════════════════════════════════════════════════════════
const briefs = {
  /**
   * Create a new brief. Most fields optional except title and topic.
   * @param {object} data — { title, topic, handoff_packet, raw_output,
   *                          prompt_used, research_depth, campaign_goal }
   * @returns the created brief row including its new id
   */
  async create(data) {
    await _requireAuth();
    const insertData = {
      title: data.title,
      topic: data.topic,
      handoff_packet: data.handoff_packet || {},
      raw_output: data.raw_output || null,
      prompt_used: data.prompt_used || null,
      research_depth: data.research_depth || 'standard',
      campaign_goal: data.campaign_goal || null,
      status: data.status || 'draft'
    };
    const response = await supabaseClient.from('briefs').insert(insertData).select().single();
    return _unwrap(response, 'briefs.create');
  },

  /**
   * List briefs with optional filters.
   * @param {object} filters — { status, limit, orderBy }
   */
  async list(filters = {}) {
    await _requireAuth();
    let query = supabaseClient.from('briefs').select('*');
    if (filters.status) query = query.eq('status', filters.status);
    query = query.order(filters.orderBy || 'created_at', { ascending: false });
    if (filters.limit) query = query.limit(filters.limit);
    return _unwrap(await query, 'briefs.list');
  },

  /** Get a single brief by ID. */
  async get(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('briefs').select('*').eq('id', id).single(),
      'briefs.get'
    );
  },

  /** Move brief to approved status. Records who approved and when. */
  async approve(id, reviewerNotes = null) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('briefs').update({
        status: 'approved',
        approved_by: me,
        approved_at: new Date().toISOString(),
        reviewer_notes: reviewerNotes
      }).eq('id', id).select().single(),
      'briefs.approve'
    );
  },

  /** Reject a brief with a reason. */
  async reject(id, reason) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('briefs').update({
        status: 'rejected',
        rejection_reason: reason,
        approved_by: me,
        approved_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'briefs.reject'
    );
  },

  /** Archive a brief (soft delete — keeps the record). */
  async archive(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('briefs').update({
        status: 'archived',
        archived_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'briefs.archive'
    );
  },

  /** Returns briefs along with how many copy/designs/campaigns they've spawned. */
  async listWithPerformance() {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('v_brief_performance').select('*'),
      'briefs.listWithPerformance'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   COPY MODULE (Hermes's output)
// ═══════════════════════════════════════════════════════════════════════════
const copy = {
  /**
   * Create a copy asset. brief_id is REQUIRED unless quick_response is true.
   * The database will reject any insert that violates this rule.
   */
  async create(data) {
    await _requireAuth();
    if (!data.brief_id && !data.quick_response) {
      throw new Error('[TISM_DB copy.create] brief_id is required, OR set quick_response=true.');
    }
    const insertData = {
      brief_id: data.brief_id || null,
      quick_response: !!data.quick_response,
      platform: data.platform,
      format: data.format || null,
      variant_label: data.variant_label || null,
      copy_body: data.copy_body,
      cta: data.cta || null,
      hashtags: data.hashtags || null,
      recommended_post_time: data.recommended_post_time || null,
      status: data.status || 'draft',
      prompt_used: data.prompt_used || null,
      raw_output: data.raw_output || null,
      generation_cost_usd: data.generation_cost_usd || null
    };
    return _unwrap(
      await supabaseClient.from('copy_assets').insert(insertData).select().single(),
      'copy.create'
    );
  },

  /** List copy assets with filters. */
  async list(filters = {}) {
    await _requireAuth();
    let query = supabaseClient.from('copy_assets').select('*, briefs(title, topic)');
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.platform) query = query.eq('platform', filters.platform);
    if (filters.briefId) query = query.eq('brief_id', filters.briefId);
    query = query.order('created_at', { ascending: false });
    if (filters.limit) query = query.limit(filters.limit);
    return _unwrap(await query, 'copy.list');
  },

  async get(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('copy_assets').select('*, briefs(*)').eq('id', id).single(),
      'copy.get'
    );
  },

  async approve(id, reviewerNotes = null) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('copy_assets').update({
        status: 'approved',
        approved_by: me,
        approved_at: new Date().toISOString(),
        reviewer_notes: reviewerNotes
      }).eq('id', id).select().single(),
      'copy.approve'
    );
  },

  async reject(id, reason) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('copy_assets').update({
        status: 'rejected',
        rejection_reason: reason,
        approved_by: me,
        approved_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'copy.reject'
    );
  },

  async retire(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('copy_assets').update({
        status: 'retired',
        retired_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'copy.retire'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   DESIGNS MODULE (Apollo's output)
// ═══════════════════════════════════════════════════════════════════════════
const designs = {
  /**
   * Create a design asset. Same brief_id rule as copy.
   * output_type determines which fields are meaningful:
   *   'design_brief'    — uses design_brief_text, color_palette
   *   'canva_template'  — uses canva_template_id, canva_design_id, canva_export_url
   *   'generated_image' — uses image_prompt, image_model, image_url, image_width, image_height
   */
  async create(data) {
    await _requireAuth();
    if (!data.brief_id && !data.quick_response) {
      throw new Error('[TISM_DB designs.create] brief_id is required, OR set quick_response=true.');
    }
    const insertData = {
      brief_id: data.brief_id || null,
      copy_asset_id: data.copy_asset_id || null,
      quick_response: !!data.quick_response,
      output_type: data.output_type || 'design_brief',
      design_brief_text: data.design_brief_text || null,
      color_palette: data.color_palette || null,
      canva_template_id: data.canva_template_id || null,
      canva_design_id: data.canva_design_id || null,
      canva_export_url: data.canva_export_url || null,
      image_prompt: data.image_prompt || null,
      image_model: data.image_model || null,
      image_url: data.image_url || null,
      image_width: data.image_width || null,
      image_height: data.image_height || null,
      platform: data.platform || null,
      format: data.format || null,
      status: data.status || 'draft',
      prompt_used: data.prompt_used || null,
      generation_cost_usd: data.generation_cost_usd || null
    };
    return _unwrap(
      await supabaseClient.from('design_assets').insert(insertData).select().single(),
      'designs.create'
    );
  },

  async list(filters = {}) {
    await _requireAuth();
    let query = supabaseClient.from('design_assets').select('*, briefs(title, topic)');
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.outputType) query = query.eq('output_type', filters.outputType);
    if (filters.briefId) query = query.eq('brief_id', filters.briefId);
    query = query.order('created_at', { ascending: false });
    if (filters.limit) query = query.limit(filters.limit);
    return _unwrap(await query, 'designs.list');
  },

  async get(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('design_assets').select('*, briefs(*), copy_assets(*)').eq('id', id).single(),
      'designs.get'
    );
  },

  async approve(id, reviewerNotes = null) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('design_assets').update({
        status: 'approved',
        approved_by: me,
        approved_at: new Date().toISOString(),
        reviewer_notes: reviewerNotes
      }).eq('id', id).select().single(),
      'designs.approve'
    );
  },

  async reject(id, reason) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('design_assets').update({
        status: 'rejected',
        rejection_reason: reason,
        approved_by: me,
        approved_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'designs.reject'
    );
  },

  async retire(id) {
    await _requireAuth();
    // First, fetch the row to learn the storage_path so we can delete the file too.
    // This is the design choice from the soft-delete plan: metadata stays for learning,
    // but the actual image bytes go (they're the only thing that accumulates real storage).
    const { data: row, error: getErr } = await supabaseClient
      .from('design_assets')
      .select('image_url')
      .eq('id', id)
      .single();
    if (getErr) throw getErr;
    // Delete the storage file. Soft-fail: if this errors (e.g. file already gone),
    // we still proceed with the metadata update. Orphaned files are recoverable later;
    // an orphaned metadata row pointing at a missing file is also harmless.
    if (row && row.image_url) {
      try {
        await supabaseClient.storage.from('design-assets').remove([row.image_url]);
      } catch (_e) {
        console.warn('[designs.retire] storage delete failed (continuing):', _e);
      }
    }
    return _unwrap(
      await supabaseClient.from('design_assets').update({
        status: 'retired',
        retired_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'designs.retire'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   BRAND KIT MODULE
//   Manages Hyperion Labs brand identity used by Apollo for image generation.
//   - Text fields (fonts, colors, URL, notes) in `brand_kit` table (one per user)
//   - Image assets (logos, marks, style refs) in Supabase Storage bucket
//     `brand-assets`, with metadata rows in `brand_kit_assets` table
// ═══════════════════════════════════════════════════════════════════════════
const brandKit = {
  // Fetch the current user's brand kit text fields. Returns null if not yet created.
  async get() {
    await _requireAuth();
    const { data, error } = await supabaseClient
      .from('brand_kit')
      .select('*')
      .maybeSingle(); // returns null instead of erroring when no row exists
    if (error) throw error;
    return data;
  },

  // Save (upsert) the brand kit text fields for the current user.
  // Data shape: { brand_name, brand_url, fonts:[{name,usage}], colors:[{name,hex}], notes }
  async save(data) {
    const session = await _requireAuth();
    const user = session.user;
    if (!user || !user.id) throw new Error('No authenticated user found in session');
    const payload = {
      user_id: user.id,
      brand_name: data.brand_name || null,
      brand_url: data.brand_url || null,
      fonts: data.fonts || [],
      colors: data.colors || [],
      notes: data.notes || null,
      updated_at: new Date().toISOString()
    };
    return _unwrap(
      await supabaseClient
        .from('brand_kit')
        .upsert(payload, { onConflict: 'user_id' })
        .select()
        .single(),
      'brandKit.save'
    );
  },

  // List image assets for the current user, optionally filtered by asset_type.
  async listAssets(filters = {}) {
    await _requireAuth();
    let q = supabaseClient
      .from('brand_kit_assets')
      .select('*')
      .order('created_at', { ascending: false });
    if (filters.asset_type) q = q.eq('asset_type', filters.asset_type);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  // Upload an image file and create a brand_kit_assets row.
  // file: File object from a <input type="file">; assetType: 'logo'|'mark'|'style_reference'|'other'
  async uploadAsset(file, { assetType = 'other', displayName, notes } = {}) {
    const session = await _requireAuth();
    const user = session.user;
    if (!user || !user.id) throw new Error('No authenticated user found in session');
    if (!file) throw new Error('No file provided');

    // Build a path inside the user's folder (matches RLS policy expectation).
    const safeName = (file.name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${Date.now()}_${safeName}`;

    // 1) Upload bytes to Storage
    const { error: upErr } = await supabaseClient.storage
      .from('brand-assets')
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (upErr) throw upErr;

    // 2) Create the metadata row
    return _unwrap(
      await supabaseClient
        .from('brand_kit_assets')
        .insert({
          user_id: user.id,
          asset_type: assetType,
          storage_path: path,
          display_name: displayName || file.name || null,
          notes: notes || null
        })
        .select()
        .single(),
      'brandKit.uploadAsset'
    );
  },

  // Delete an asset (both the metadata row and the storage file).
  async deleteAsset(id) {
    await _requireAuth();
    // First fetch the row so we know the storage path.
    const { data: row, error: getErr } = await supabaseClient
      .from('brand_kit_assets')
      .select('storage_path')
      .eq('id', id)
      .single();
    if (getErr) throw getErr;
    // Remove from storage (if this fails, we still delete the row; orphan files are recoverable).
    if (row && row.storage_path) {
      await supabaseClient.storage.from('brand-assets').remove([row.storage_path]);
    }
    return _unwrap(
      await supabaseClient.from('brand_kit_assets').delete().eq('id', id).select().single(),
      'brandKit.deleteAsset'
    );
  },

  // Get a short-lived signed URL for displaying or sending an asset.
  // Used by the Brand Kit UI for previews, and later by Apollo's edge function
  // to give GPT Image access to brand references.
  async getSignedUrl(storagePath, expiresInSeconds = 3600) {
    await _requireAuth();
    const { data, error } = await supabaseClient.storage
      .from('brand-assets')
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw error;
    return data?.signedUrl || null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   CAMPAIGNS MODULE
// ═══════════════════════════════════════════════════════════════════════════
const campaigns = {
  async create(data) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('campaigns').insert({
        name: data.name,
        platform: data.platform,
        objective: data.objective || null,
        brief_id: data.brief_id || null,
        primary_copy_id: data.primary_copy_id || null,
        primary_design_id: data.primary_design_id || null,
        daily_budget_usd: data.daily_budget_usd || null,
        total_budget_usd: data.total_budget_usd || null,
        target_cpl_usd: data.target_cpl_usd || null,
        target_roas: data.target_roas || null,
        target_leads: data.target_leads || null,
        target_revenue_usd: data.target_revenue_usd || null,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        offer_description: data.offer_description || null,
        target_audience: data.target_audience || null,
        status: data.status || 'draft'
      }).select().single(),
      'campaigns.create'
    );
  },

  async list(filters = {}) {
    await _requireAuth();
    let query = supabaseClient.from('campaigns').select('*');
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.platform) query = query.eq('platform', filters.platform);
    query = query.order('created_at', { ascending: false });
    if (filters.limit) query = query.limit(filters.limit);
    return _unwrap(await query, 'campaigns.list');
  },

  async get(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('campaigns').select('*').eq('id', id).single(),
      'campaigns.get'
    );
  },

  async updateStatus(id, status) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('campaigns').update({ status }).eq('id', id).select().single(),
      'campaigns.updateStatus'
    );
  },

  /** Insert a daily metric row. Idempotent — re-syncing same date overwrites. */
  async recordMetrics(campaignId, metrics) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('campaign_metrics').upsert({
        campaign_id: campaignId,
        metric_date: metrics.metric_date,
        hours_since_launch: metrics.hours_since_launch || null,
        impressions: metrics.impressions || 0,
        clicks: metrics.clicks || 0,
        spend_usd: metrics.spend_usd || 0,
        conversions: metrics.conversions || 0,
        revenue_usd: metrics.revenue_usd || 0,
        ctr: metrics.ctr || null,
        cpl_usd: metrics.cpl_usd || null,
        roas: metrics.roas || null,
        data_source: metrics.data_source || 'manual'
      }, { onConflict: 'campaign_id,metric_date,data_source' }).select(),
      'campaigns.recordMetrics'
    );
  },

  /** Get latest performance snapshot for one campaign. */
  async latestPerformance(campaignId) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient
        .from('v_campaign_latest_performance')
        .select('*')
        .eq('campaign_id', campaignId)
        .maybeSingle(),
      'campaigns.latestPerformance'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   PRINCIPLES MODULE (Athena's governance layer)
// ═══════════════════════════════════════════════════════════════════════════
const principles = {
  /** List principles for an agent, optionally filtered by status. */
  async list(filters = {}) {
    await _requireAuth();
    let query = supabaseClient.from('agent_principles').select('*');
    if (filters.agent) query = query.eq('agent', filters.agent);
    if (filters.status) query = query.eq('status', filters.status);
    query = query.order('confidence', { ascending: false });
    if (filters.limit) query = query.limit(filters.limit);
    return _unwrap(await query, 'principles.list');
  },

  /** Returns only ACTIVE principles for an agent — what gets injected into prompts. */
  async activeForAgent(agent) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient
        .from('v_active_principles')
        .select('*')
        .eq('agent', agent),
      'principles.activeForAgent'
    );
  },

  /** Athena proposes a new principle. Starts in 'proposed' status pending review. */
  async propose(data) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('agent_principles').insert({
        agent: data.agent,
        principle: data.principle,
        category: data.category || null,
        evidence_summary: data.evidence_summary || null,
        supporting_record_ids: data.supporting_record_ids || [],
        sample_size: data.sample_size || null,
        confidence: data.confidence || null,
        proposed_by: data.proposed_by || 'athena_weekly_distillation',
        status: 'proposed'
      }).select().single(),
      'principles.propose'
    );
  },

  /** Human ratifies a proposed principle — it becomes active and enters prompts. */
  async ratify(id) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('agent_principles').update({
        status: 'active',
        ratified_by: me,
        ratified_at: new Date().toISOString()
      }).eq('id', id).select().single(),
      'principles.ratify'
    );
  },

  /** Deprecate an active principle that's no longer working. */
  async deprecate(id, reason) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('agent_principles').update({
        status: 'deprecated',
        deprecated_at: new Date().toISOString(),
        deprecation_reason: reason
      }).eq('id', id).select().single(),
      'principles.deprecate'
    );
  },

  /**
   * Manually create a principle, straight to active status (bypasses the proposed→ratified flow).
   * Used by the human editor for typed-in principles. Athena's automated flow still uses propose().
   */
  async create(data) {
    await _requireAuth();
    const me = await _whoAmI();
    return _unwrap(
      await supabaseClient.from('agent_principles').insert({
        agent: data.agent,
        principle: data.principle,
        category: data.category || 'manual',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.9,
        proposed_by: me || 'manual_editor',
        ratified_by: me,
        ratified_at: new Date().toISOString(),
        status: 'active'
      }).select().single(),
      'principles.create'
    );
  },

  /** Edit the text or confidence of an existing principle. */
  async update(id, changes) {
    await _requireAuth();
    const payload = {};
    if (typeof changes.principle === 'string') payload.principle = changes.principle;
    if (typeof changes.confidence === 'number') payload.confidence = changes.confidence;
    return _unwrap(
      await supabaseClient.from('agent_principles').update(payload).eq('id', id).select().single(),
      'principles.update'
    );
  },

  /** Reactivate a deprecated principle (clears the deprecation timestamp). */
  async reactivate(id) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('agent_principles').update({
        status: 'active',
        deprecated_at: null,
        deprecation_reason: null
      }).eq('id', id).select().single(),
      'principles.reactivate'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   AGENT RUNS MODULE (episodic log of every Claude call)
// ═══════════════════════════════════════════════════════════════════════════
const runs = {
  /** Log a completed agent run. Cheap, called after every Claude API response. */
  async log(data) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('agent_runs').insert({
        agent: data.agent,
        run_type: data.run_type,
        input_prompt: data.input_prompt || null,
        input_context: data.input_context || null,
        output_text: data.output_text || null,
        output_asset_id: data.output_asset_id || null,
        output_asset_type: data.output_asset_type || null,
        model: data.model || 'claude-sonnet-4-6',
        input_tokens: data.input_tokens || null,
        output_tokens: data.output_tokens || null,
        cost_usd: data.cost_usd || null,
        duration_ms: data.duration_ms || null
      }).select().single(),
      'runs.log'
    );
  },

  /** Set the outcome of a run after we know how it performed. */
  async recordOutcome(id, outcome, metrics = null) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient.from('agent_runs').update({
        outcome,
        outcome_set_at: new Date().toISOString(),
        outcome_metrics: metrics
      }).eq('id', id).select().single(),
      'runs.recordOutcome'
    );
  },

  /** List recent runs for an agent — used by the weekly distillation. */
  async listForAgent(agent, limit = 100) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient
        .from('agent_runs')
        .select('*')
        .eq('agent', agent)
        .order('created_at', { ascending: false })
        .limit(limit),
      'runs.listForAgent'
    );
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   LINEAGE MODULE (read-only views, trace cause and effect)
// ═══════════════════════════════════════════════════════════════════════════
const lineage = {
  /** For a given campaign, returns the brief → copy → design chain. */
  async ofCampaign(campaignId) {
    await _requireAuth();
    return _unwrap(
      await supabaseClient
        .from('v_campaign_lineage')
        .select('*')
        .eq('campaign_id', campaignId)
        .single(),
      'lineage.ofCampaign'
    );
  },

  /** For a given brief, returns everything downstream that used it. */
  async ofBrief(briefId) {
    await _requireAuth();
    const [copyResult, designsResult, campaignsResult] = await Promise.all([
      supabaseClient.from('copy_assets').select('*').eq('brief_id', briefId),
      supabaseClient.from('design_assets').select('*').eq('brief_id', briefId),
      supabaseClient.from('campaigns').select('*').eq('brief_id', briefId)
    ]);
    return {
      copy: _unwrap(copyResult, 'lineage.ofBrief.copy'),
      designs: _unwrap(designsResult, 'lineage.ofBrief.designs'),
      campaigns: _unwrap(campaignsResult, 'lineage.ofBrief.campaigns')
    };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   EXPORT — attach everything to window so TISM HTML can use it
// ═══════════════════════════════════════════════════════════════════════════
window.TISM_DB = {
  auth,
  briefs,
  copy,
  designs,
  campaigns,
  brandKit,
  principles,
  runs,
  lineage,
  // raw client for advanced cases (don't use unless you know what you're doing)
  _client: supabaseClient
};

console.log('[TISM_DB] Loaded. Available at window.TISM_DB');
