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
    flow:['Read existing module state and target theme','Build and inspect a ZIP',
      'Upload through the module endpoint','Apply to the authorized domain/theme',
      'Read the module API and page result','Add its menu entry after successful verification'],
    failures:{bad_extension:'The image upload admission layer needs the module ZIP compatibility fix.',
      pattern_match_php_tag:'Use the module ZIP endpoint. Keep the request WAF enabled.',
      applicationError:'Read installed state before retrying. Acknowledgement alone does not prove the API or page works.'}
  };
}
