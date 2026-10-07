// SPDX-License-Identifier: AGPL-3.0-or-later

//! Myserycord: custom profile badges. Create badges (name, description, image) and give
//! them to users. Data lives in the API (`/admin/myserycord/badges`).

use crate::{
    acl,
    api::{
        client::{AdminApiClient, ApiResult, ApiResultExt},
        types::AdminUser,
    },
    middleware::{
        auth::AuthContext,
        csrf::CsrfToken,
        flash::{self, FlashData},
    },
    routes::ActionQuery,
    state::AppState,
    templates::{
        components::{
            form::{csrf_input, danger_button, submit_button, text_input},
            page_container::page_header,
        },
        layout::admin_layout,
    },
    utils::forms::MultiValueForm,
};
use axum::{
    Router,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use maud::{Markup, html};
use serde::Deserialize;
use std::collections::BTreeMap;

const ACTIVE_PAGE: &str = "badges";

#[derive(Deserialize)]
struct Badge {
    id: String,
    name: String,
    description: String,
    icon_rev: u32,
}

#[derive(Deserialize)]
struct BadgesState {
    badges: Vec<Badge>,
    users: BTreeMap<String, Vec<String>>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/badges", get(badges_page).post(badges_post))
        .route("/badges/{badge_id}/icon", get(badge_icon))
}

fn can_edit(auth: &AuthContext) -> bool {
    let acls = auth
        .admin_user
        .as_ref()
        .map(|user| user.acls.as_slice())
        .unwrap_or(&[]);
    acl::has_permission(acls, acl::USER_UPDATE_FLAGS)
}

async fn badges_page(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    csrf: axum::Extension<CsrfToken>,
    flash: Option<axum::Extension<FlashData>>,
) -> Response {
    let config = state.config();
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let data: Option<BadgesState> = client
        .get("/admin/myserycord/badges", None)
        .await
        .log_error("load custom badges");
    let holder_ids: Vec<String> = data
        .as_ref()
        .map(|d| d.users.keys().cloned().collect())
        .unwrap_or_default();
    let holders = client
        .lookup_users_by_ids(&holder_ids)
        .await
        .log_error("load custom badge holders")
        .unwrap_or_default();
    let flash = flash.map(|flash| flash.0.to_flash_message());
    let content = page_content(
        &config.base_path,
        &csrf.0.0,
        data.as_ref(),
        &holders,
        can_edit(&auth.0),
    );
    let markup = admin_layout(config, &auth.0, "Badges", ACTIVE_PAGE, flash.as_ref(), content);
    Html(markup.into_string()).into_response()
}

/// Serves the image through the admin origin, which its CSP allows.
async fn badge_icon(State(state): State<AppState>, Path(badge_id): Path<String>) -> Response {
    if badge_id.len() != 12 || !badge_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let url = format!(
        "{}/myserycord/badges/{badge_id}/icon",
        state.config().api_endpoint
    );
    let Ok(response) = state.http_client().get(&url).send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    if !response.status().is_success() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    match response.bytes().await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox".to_owned(),
                ),
                (header::CACHE_CONTROL, "private, max-age=300".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

async fn badges_post(
    State(state): State<AppState>,
    auth: axum::Extension<AuthContext>,
    Query(aq): Query<ActionQuery>,
    request: Request,
) -> Response {
    let config = state.config();
    let back = format!("{}/badges", config.base_path);
    let secure = config.secure_cookies();
    let Some(form) = MultiValueForm::from_request(request).await else {
        return flash::redirect_with_flash(&back, FlashData::error("Invalid form data"), secure);
    };
    let client = AdminApiClient::new(state.http_client(), config, &auth.0.session);
    let flash = match run_action(&client, aq.action.as_deref().unwrap_or(""), &form).await {
        Ok(message) => FlashData::success(message),
        Err(message) => FlashData::error(message),
    };
    flash::redirect_with_flash(&back, flash, secure)
}

fn badge_id(form: &MultiValueForm) -> Result<String, String> {
    form.clean("badge_id")
        .filter(|id| id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| "Unknown badge".to_owned())
}

/// Image fields filled in by the page script: base64 bytes and their MIME type.
fn icon_fields(form: &MultiValueForm) -> Option<(String, String)> {
    Some((form.clean("icon")?, form.clean("icon_type")?))
}

async fn run_action(
    client: &AdminApiClient,
    action: &str,
    form: &MultiValueForm,
) -> Result<String, String> {
    let api = |result: ApiResult<serde_json::Value>| result.map_err(|e| e.to_string());
    match action {
        "create" => {
            let name = form.clean("name").ok_or("A name is required")?;
            let (icon, icon_type) = icon_fields(form).ok_or("An image is required")?;
            let body = serde_json::json!({
                "name": name,
                "description": form.clean("description").unwrap_or_default(),
                "icon": icon,
                "icon_type": icon_type,
            });
            api(client.post("/admin/myserycord/badges", Some(&body)).await)?;
            Ok(format!("Badge \"{name}\" created"))
        }
        "update" => {
            let id = badge_id(form)?;
            let mut body = serde_json::json!({
                "name": form.clean("name").ok_or("A name is required")?,
                "description": form.clean("description").unwrap_or_default(),
            });
            if let Some((icon, icon_type)) = icon_fields(form) {
                body["icon"] = icon.into();
                body["icon_type"] = icon_type.into();
            }
            api(client
                .patch(&format!("/admin/myserycord/badges/{id}"), Some(&body))
                .await)?;
            Ok("Badge updated".to_owned())
        }
        "delete" => {
            let id = badge_id(form)?;
            api(client
                .delete_with_reason(&format!("/admin/myserycord/badges/{id}"), None, None)
                .await)?;
            Ok("Badge deleted".to_owned())
        }
        "assign" => {
            let id = badge_id(form)?;
            let query = form.clean("user").ok_or("Enter a user")?;
            let user: AdminUser = client
                .lookup_user(&query)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("No user matches \"{query}\""))?;
            api(client
                .put_with_reason(
                    &format!("/admin/myserycord/badges/{id}/users/{}", user.id),
                    None,
                    None,
                )
                .await)?;
            Ok(format!("Badge given to {}", user.username))
        }
        "unassign" => {
            let id = badge_id(form)?;
            let user_id = form
                .clean("user_id")
                .filter(|v| v.bytes().all(|b| b.is_ascii_digit()))
                .ok_or("Unknown user")?;
            api(client
                .delete_with_reason(
                    &format!("/admin/myserycord/badges/{id}/users/{user_id}"),
                    None,
                    None,
                )
                .await)?;
            Ok("Badge taken back".to_owned())
        }
        _ => Err("Unknown action".to_owned()),
    }
}

const CARD: &str = "rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-6";

fn page_content(
    base: &str,
    csrf: &str,
    data: Option<&BadgesState>,
    holders: &[AdminUser],
    editable: bool,
) -> Markup {
    let action = |name: &str| format!("{base}/badges?action={name}&_csrf={csrf}");
    let icon = |badge: &Badge| format!("{base}/badges/{}/icon?rev={}", badge.id, badge.icon_rev);
    let holder_name = |user_id: &str| {
        holders
            .iter()
            .find(|u| u.id == user_id)
            .map(|u| u.username.clone())
            .unwrap_or_else(|| user_id.to_owned())
    };
    let header = page_header(
        "Badges",
        Some("Custom badges shown on user profiles, next to the official ones."),
    );
    let Some(data) = data else {
        return html! {
            (header)
            p class="text-sm text-red-700" { "Could not load the badges from the API." }
        };
    };
    html! {
        (header)
        div class="space-y-6" {
            @if editable {
                div class=(CARD) {
                    h3 class="text-base font-medium text-neutral-900 mb-4" { "Create a badge" }
                    form method="post" action=(action("create")) data-badge-form {
                        (csrf_input(csrf))
                        div class="grid gap-4 sm:grid-cols-2" {
                            (text_input("name", "Name", "", "VIP"))
                            (text_input("description", "Description (optional)", "", "Shown in the tooltip"))
                        }
                        (icon_input(true))
                        div class="mt-4" { (submit_button("Create")) }
                    }
                }
            }
            div class=(CARD) {
                h3 class="text-base font-medium text-neutral-900 mb-4" { "Badges" }
                @if data.badges.is_empty() {
                    p class="text-sm text-neutral-500" { "No badge yet." }
                }
                div class="divide-y divide-neutral-200" {
                    @for badge in &data.badges {
                        @let wearers: Vec<&String> = data.users.iter().filter(|(_, ids)| ids.contains(&badge.id)).map(|(uid, _)| uid).collect();
                        div class="py-4 space-y-3" {
                            div class="flex items-center gap-3" {
                                img src=(icon(badge)) alt=(badge.name) class="h-8 w-8 object-contain";
                                div {
                                    div class="font-medium text-neutral-900" { (badge.name) }
                                    div class="text-sm text-neutral-500" { (badge.description) }
                                }
                            }
                            div class="flex flex-wrap gap-2" {
                                @for uid in &wearers {
                                    form method="post" action=(action("unassign")) class="inline-flex items-center gap-1 rounded-full border border-neutral-200 px-3 py-1 text-sm" {
                                        (csrf_input(csrf))
                                        input type="hidden" name="badge_id" value=(badge.id);
                                        input type="hidden" name="user_id" value=(uid);
                                        a href={(base) "/users/" (uid)} class="text-neutral-900 hover:underline" { (holder_name(uid)) }
                                        @if editable {
                                            button type="submit" class="text-red-600" title="Take back" { "×" }
                                        }
                                    }
                                }
                                @if wearers.is_empty() {
                                    span class="text-sm text-neutral-500" { "Nobody wears it." }
                                }
                            }
                            @if editable {
                                form method="post" action=(action("assign")) class="flex flex-wrap items-end gap-2" {
                                    (csrf_input(csrf))
                                    input type="hidden" name="badge_id" value=(badge.id);
                                    div class="min-w-64 flex-1" { (text_input("user", "Give to", "", "Username, username#0000, user ID or email")) }
                                    (submit_button("Give"))
                                }
                                details {
                                    summary class="cursor-pointer text-sm text-neutral-600" { "Edit or delete" }
                                    form method="post" action=(action("update")) data-badge-form class="mt-3 space-y-3" {
                                        (csrf_input(csrf))
                                        input type="hidden" name="badge_id" value=(badge.id);
                                        div class="grid gap-4 sm:grid-cols-2" {
                                            (text_input("name", "Name", &badge.name, ""))
                                            (text_input("description", "Description", &badge.description, ""))
                                        }
                                        (icon_input(false))
                                        (submit_button("Save"))
                                    }
                                    form method="post" action=(action("delete")) class="mt-3"
                                        onsubmit="return confirm('Delete this badge and take it from everyone?')" {
                                        (csrf_input(csrf))
                                        input type="hidden" name="badge_id" value=(badge.id);
                                        (danger_button("Delete badge"))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        (icon_script())
    }
}

fn icon_input(required: bool) -> Markup {
    html! {
        div class="mt-4 flex flex-col gap-2" {
            label class="text-sm font-medium text-neutral-700" {
                @if required { "Image" } @else { "New image (optional)" }
            }
            input type="file" accept="image/png,image/webp,image/gif,image/svg+xml" required[required] data-badge-file class="text-sm";
            span class="text-xs text-neutral-500" { "Square PNG, WebP, GIF or SVG, 128 KiB at most. Shown at 20 px." }
            input type="hidden" name="icon";
            input type="hidden" name="icon_type";
        }
    }
}

/// Fills the hidden icon fields with the chosen file as base64, so the form can stay
/// urlencoded like the rest of the panel.
fn icon_script() -> Markup {
    html! {
        script {
            (maud::PreEscaped(r#"
document.querySelectorAll('[data-badge-file]').forEach((input) => {
  input.addEventListener('change', () => {
    const form = input.form, file = input.files[0];
    form.elements.icon.value = ''; form.elements.icon_type.value = '';
    if (!file) return;
    if (file.size > 128 * 1024) { alert('The image is larger than 128 KiB.'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      form.elements.icon.value = String(reader.result).split(',')[1];
      form.elements.icon_type.value = file.type;
    };
    reader.readAsDataURL(file);
  });
});
"#))
        }
    }
}
