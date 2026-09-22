/* Shared chrome strings for every page. Pages add their own copy via
   window.PAGE_I18N = {en:{...}, es:{...}} before this script loads. */
(function(){
  var CHROME = {
    en: {
      login:"Patient Login",
      nServices:"Services", nComp:"Workers' Comp", nEval:"Evaluations",
      nProviders:"Providers", nLocations:"Locations", nContact:"Contact",
      fContact:"Contact", fPrivacy:"Privacy", fAccess:"Accessibility", fSms:"SMS Terms"
    },
    es: {
      login:"Acceso de pacientes",
      nServices:"Servicios", nComp:"Compensación laboral", nEval:"Evaluaciones",
      nProviders:"Proveedores", nLocations:"Ubicaciones", nContact:"Contacto",
      fContact:"Contacto", fPrivacy:"Privacidad", fAccess:"Accesibilidad", fSms:"Términos de SMS"
    }
  };

  function dictFor(lang){
    var page = (window.PAGE_I18N && window.PAGE_I18N[lang]) || {};
    var chrome = CHROME[lang] || CHROME.en;
    var out = {};
    for (var k in chrome) out[k] = chrome[k];
    for (var j in page) out[j] = page[j];
    return out;
  }

  function apply(lang){
    if (!CHROME[lang]) lang = "en";
    var d = dictFor(lang);
    document.documentElement.setAttribute("lang", lang);
    document.querySelectorAll("[data-i18n]").forEach(function(el){
      var v = d[el.getAttribute("data-i18n")];
      if (typeof v === "string") el.textContent = v;
    });
    // list-type strings: element expects an array joined with a middle dot
    document.querySelectorAll("[data-i18n-pills]").forEach(function(el){
      var vp = d[el.getAttribute("data-i18n-pills")];
      if (Array.isArray(vp)) el.innerHTML = vp.map(function(s){return '<span class="pill">'+s+'</span>';}).join('');
    });
    document.querySelectorAll("[data-i18n-list]").forEach(function(el){
      var v = d[el.getAttribute("data-i18n-list")];
      if (Array.isArray(v)) el.innerHTML = v.map(function(s){return '<span>'+s+'</span>';}).join('<i>·</i>');
    });
    document.querySelectorAll(".lang button").forEach(function(b){
      b.setAttribute("aria-pressed", String(b.getAttribute("data-setlang") === lang));
    });
    try { localStorage.setItem("tpg-lang", lang); } catch(e){}
  }

  document.querySelectorAll(".lang button").forEach(function(b){
    b.addEventListener("click", function(){ apply(b.getAttribute("data-setlang")); });
  });

  var saved = "en";
  try { saved = localStorage.getItem("tpg-lang") || "en"; } catch(e){}
  apply(saved);
})();
