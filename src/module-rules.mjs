export function moduleRules(){
  return {
    package:{manifest:['config.json','module.json'],archiveBytes:30*1024*1024,entries:1500,
      expandedBytes:30*1024*1024,fileBytes:4*1024*1024,apiFileBytes:256*1024},
    templates:{format:'Public Zonely DSL or HTML',phpAllowed:false},
    api:{directory:'api/',extension:'.php',database:'Use the supplied moduleDb object and prepared statements',
      publicRead:'Declare public=true and methods=[GET] for public data',
      write:'Require a signed-in authorized account, POST and CSRF validation',
      blocked:['shell/process execution','eval/include/require','network and cURL','filesystem and environment access',
        'dynamic calls and function aliases','runtime-limit changes','sleep and delay functions'],
      runtime:{existingControllerSeconds:8,existingControllerMemoryMiB:64,
        boundary:'Static validation and PHP budgets. This is not operating-system process isolation.'}},
    sftp:{scope:'modules',root:'/Modules',package:'<module-id>/package.zip',
      source:'<module-id>/source/',apiSourceExtension:'.php.txt',
      restoreNames:'Every original .php file is exported as .php.txt. Restore its .php name only inside the rebuilt ZIP.',
      edits:'Source edits remain drafts. Rebuild the ZIP and use validated module upload/apply.',
      conflicts:'Exports retain modified drafts and return conflicts for review.'},
    adminPages:{
      route:'Discover the module-specific canonical route in the native Route Filters catalog before linking a sidebar item.',
      alias:'Use route.alias only for a registered admin route. Preserve its parameters and verify the catalog readback.',
      missingRoute:'A module template or successful ZIP application does not register a route. If the canonical module route is missing, report that the host needs a module page registration facility. Do not alias an unrelated native page.',
      sidebar:'Use a supported admin navigation extension after verifying the dedicated admin page and its permission.',
      table:'Use the existing Zonely admin DataTables bundle. Verify the sidebar opens the page and a real record appears.'
    },
    placement:{
      admin:'Use a dedicated /admin/addons/<module-id> or /admin/<module-id> page and a sidebar link in the existing related admin group. Pass adminPage to zonely_module_install and verify with zonely_module_admin_check.',
      unsupported:'If the dedicated route or supported sidebar integration is unavailable, report it as incomplete. Never place the admin screen in Özel Sayfalar, on the homepage, in another admin page, or behind a public page query parameter.',
      player:'Create or edit the requested player-facing page only. Add a public menu link only when the requested navigation calls for it. Never use this page to manage the module.',
      homepage:'Edit the homepage only when the request explicitly calls for a homepage section. Use the existing theme content and render the page to verify placement.',
      verification:'Installation and page placement are separate outcomes. Confirm the dedicated route, module content marker, sidebar label and requested DataTable before reporting the admin page ready.'
    },
    flow:['Read existing module state and target theme','Build and inspect a ZIP',
      'Upload through the module endpoint','Apply to the authorized domain/theme',
      'Read the module API and page result','Add its menu entry after successful verification'],
    upload:{legacyField:'archive',workspaceField:'module_zip',tool:'zonely_module_install',visibility:'hidden',
      workspaceLegacyPackage:'Use config.json, templates/, admin_templates/ and the supported module_api/ directory for legacy template modules.'},
    failures:{bad_extension:'Check the documented upload action and multipart field. If they match, verify the server supports module ZIP uploads.',
      pattern_match_php_tag:'Use the module ZIP endpoint. Keep the request WAF enabled.',
      dynamicResponse:'Use a named JSON response helper; dynamic closure calls may be blocked. Keep captured JSON below 200,000 bytes.',
      applicationError:'Read installed state before retrying. Acknowledgement alone does not prove the API or page works.'}
  };
}
