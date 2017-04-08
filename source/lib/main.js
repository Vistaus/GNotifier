/**
 * GNotifier - Firefox/Thunderbird add-on that replaces
 * built-in notifications with the OS native notifications
 *
 * Copyright 2014 by Michal Kosciesza <michal@mkiol.net>
 * Copyright 2014 by Alexander Schlarb <alexander1066@xmine128.tk>
 * Copyright 2014 by Joe Simpson <headbangerkenny@gmail.com>
 *
 * Licensed under GNU General Public License 3.0 or later.
 * Some rights reserved. See COPYING, AUTHORS.
 *
 * @license GPL-3.0 <https://www.gnu.org/licenses/gpl-3.0.html>
 */

/* eslint-disable no-unused-vars */
let { Cc, Ci, Cu, Cm, Cr, components } = require("chrome");
/* eslint-enable no-unused-vars */

Cu.import("resource://gre/modules/Timer.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Downloads.jsm");

const _ = require("sdk/l10n").get;
const utils = require("./utils.js");
const sps = require("sdk/simple-prefs").prefs;
const system = require("sdk/system");

const origAlertsServiceFactory = Cm.getClassObject(Cc["@mozilla.org/alerts-service;1"], Ci.nsIFactory);
const origAlertsService = Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);

let notifApi;

function showDownloadCompleteNotification(path) {
  const filename = path.replace(/^.*[\\\/]/, "");

  // Check if file extension is excluded
  const ext = utils.getFileExtension(filename).toLowerCase();
  if (sps["excludedExtensionsList"] !== "") {
    const excludedExtensionsList = sps["excludedExtensionsList"].split(",");
    for (let i = 0; i < excludedExtensionsList.length; i++) {
      const eext = excludedExtensionsList[i].toLowerCase().trim();
      if (ext === eext) {
        // File extension is excluded
        return;
      }
    }
  }

  const title = _("download_finished");
  const text = filename;

  // If engine = 1 & linux & supports action buttons, add 2 actions:
  // open file & open folder
  if (sps["engine"] === 1 &&
      system.platform === "linux" &&
      notifApi.checkButtonsSupported()) {

    // Fix for Plasma4: Space on buttons is small so using short labels
    const plasma = notifApi.checkPlasma();

    let actions;
    if (sps["clickOption"] == 0) {
      actions = [{
        label: plasma ? _("Folder") : _("Open_folder"),
        handler: ()=>{utils.openDir(path)}
      }, {
        label: plasma ? _("File") : _("Open_file"),
        handler: ()=>{utils.openFile(path)}
      }];
    } else {
      actions = [{
        label: plasma ? _("File") : _("Open_file"),
        handler: ()=>{utils.openFile(path)}
      }, {
        label: plasma ? _("Folder") : _("Open_folder"),
        handler: ()=>{utils.openDir(path)}
      }];
    }

    if (notifApi.notifyWithActions(utils.getIcon(), title, text,
        system.name, (reason)=>{}, actions))
      return;
  }

  // Below only makes sense for some linux distros e.g. KDE, Gnome Shell
  // If linux and libnotify is inited, add "Open" button:
  // <input text="Open" type="submit"/>
  if (sps["engine"] === 1 && system.platform === "linux")
      text = text+"<input text='"+_("open")+"' type='submit'/>";

  // Generate standard desktop notification
  const notifications = require("sdk/notifications");
  notifications.notify({
    title: title,
    text: text,
    iconURL: utils.getIcon(),
    onClick: ()=>{
      if (sps['clickOption'] == 0) {
        utils.openDir(path);
      } else {
        utils.openFile(path);
      };
    }
  });
}

// Works only for FF<26 and SeaMonkey
const downloadProgressListener = {
  onDownloadStateChange: (aState, aDownload)=>{
    const dm = Cc["@mozilla.org/download-manager;1"].getService(Ci.nsIDownloadManager);
    if (sps["downloadCompleteAlert"]) {
      switch(aDownload.state) {
      case dm.DOWNLOAD_FINISHED:
        showDownloadCompleteNotification(aDownload.target.path);
        break;
      }
    }
  }
}

// Works only for FF>=26
Task.spawn(()=>{
  try {
    let list = yield Downloads.getList(Downloads.ALL);
    let view = {
      onDownloadChanged: function(download) {
        if(sps['downloadCompleteAlert'] && download.succeeded) {
          if (download.target.exists === undefined || download.target.exists === true) {
            console.log("onDownloadChanged: " + download.target.path);
            showDownloadCompleteNotification(download.target.path);
          }
        }
      }
    };
    yield list.addView(view);
  } catch(e) {
    console.error("Unexpected exception ",e);
  }
}).then(null, Cu.reportError);

// New implmentation of Alert Service
function AlertsService() {}
AlertsService.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAlertsService]),

  // New nsIAlertsService API (FF 46)
  showAlert: (alert, alertListener)=>{
    this.showAlertNotification(alert.imageURL, alert.title, alert.text,
      alert.textClickable, alert.cookie, alertListener, alert.name,
      alert.dir, alert.lang);
  },

  showAlertNotification: (imageUrl, title, text, textClickable, cookie,
                          alertListener, name, dir, lang)=>{
    // Engine 0 - FF built-in
    if (sps["engine"] === 0) {
      origAlertsService.showAlertNotification(imageUrl, title, text,
        textClickable, cookie, alertListener, name, dir, lang);
      return;
    }

    // Engine 2 - custom command
    if (sps["engine"] === 2) {
      if (sps["command"] !== "") {
        let command = sps['command'];
        command = command.replace("%image",imageUrl);
        command = command.replace("%title",title);
        command = command.replace("%text",text);
        utils.execute(command);
      }
      return;
    }

    function GNotifier_AlertsService_showAlertNotification_cb(iconPath) {
      const closeHandler = (reason)=>{
        if(alertListener) {
          alertListener.observe(null, "alertfinished", cookie);
        }
      };

      const clickHandler = textClickable ? ()=>{
        if(alertListener) {
          alertListener.observe(null, "alertclickcallback", cookie);
        }
      } : null;

      // Send notification via notifyApi implemenation
      if (notifApi.notify(iconPath, title, text, system.name,
        closeHandler, clickHandler)) {
        // Generating "alertshow"
        if(alertListener) {
          alertListener.observe(null, "alertshow", cookie);
        }
      } else {
        console.log("Notify fails!");
      }
    }

    if (!imageUrl) {
      GNotifier_AlertsService_showAlertNotification_cb("");
      return;
    }

    try {
      // Try using a local icon file URL
      const imageURI = NetUtil.newURI(imageUrl);
      const iconFile = imageURI.QueryInterface(Ci.nsIFileURL).file;
      GNotifier_AlertsService_showAlertNotification_cb(iconFile.path);
    } catch(e) {
      try {
        const imageHash = "gnotifier-"+utils.getHash(imageUrl);
        const tempIconFile = FileUtils.getFile("TmpD", ["gnotifier", imageHash]);
        if (tempIconFile.exists()) {
          // icon file exists in tmp, using tmp file
          GNotifier_AlertsService_showAlertNotification_cb(tempIconFile.path);
        } else {
          // icon file doesn't exist in tmp, downloading icon to tmp file
          const imageFile = NetUtil.newChannel(imageUrl);
          NetUtil.asyncFetch(imageFile, (imageStream,result)=>{
            if (!components.isSuccessCode(result)) {
              console.warn("NetUtil.asyncFetch error! result:",result);
              return;
            }
            // Create temporary local file
            // (Required since I don't want to manually
            //  populate a GdkPixbuf...)
            tempIconFile.createUnique(
              Ci.nsIFile.NORMAL_FILE_TYPE,
              FileUtils.PERMS_FILE
            );
            const iconStream = FileUtils.openSafeFileOutputStream(tempIconFile);
            NetUtil.asyncCopy(imageStream, iconStream, function(result) {
              if (!components.isSuccessCode(result)) {
                console.log("NetUtil.asyncCopy error! result:", result);
                return;
              }
              GNotifier_AlertsService_showAlertNotification_cb(tempIconFile.path);
              iconStream.close();
              imageStream.close();
            });
          });
        }
      } catch(e) {
        GNotifier_AlertsService_showAlertNotification_cb(imageUrl);
      }
    }
  }
};

function deleteTempFiles () {
  const tempDir = FileUtils.getDir("TmpD",["gnotifier"]);
  const entries = tempDir.directoryEntries;
  while(entries.hasMoreElements()) {
    let entry = entries.getNext();
    entry.QueryInterface(Ci.nsIFile);
    const filename = entry.path.replace(/^.*[\\\/]/, '');
    if (filename.substring(0, 10) === "gnotifier-")
      entry.remove(false);
  }
}

exports.main = (options, callbacks)=>{
  if (!notifApi) {
    if (system.platform === "winnt") {
      notifApi = require("./windows.js");
    } else {
      notifApi = require("./linux.js");
    }
  }

  if(notifApi.init()) {
    // Replace alert-service
    const contract = "@mozilla.org/alerts-service;1";
    let registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);

    // Unregister built-in alerts-service class factory
    registrar.unregisterFactory(
      Cc[contract],
      Cm.getClassObject(Cc[contract], Ci.nsIFactory)
    );

    // Register new factory
    registrar.registerFactory(
      Cc[contract],
      "GNotifier Alerts Service",
      contract,
      XPCOMUtils.generateSingletonFactory(AlertsService)
    );
  } else {
    notifApi = null;
    console.error("Notification API init has failed!");
    return;
  }

  try {
    // Works only in FF<26 and SeaMonkey
    let dm = Cc["@mozilla.org/download-manager;1"].getService(Ci.nsIDownloadManager);
    dm.addListener(downloadProgressListener);
  } catch(e) {}

  try {
    // Works only in FF<26 and SeaMonkey
    let ps = require("sdk/preferences/service");
    if (sps["downloadCompleteAlert"])
      ps.set("browser.download.manager.showAlertOnComplete", false);
    else
      ps.set("browser.download.manager.showAlertOnComplete", true);
  } catch(e) {}

  // Thunderbird init
  if (system.name == "Thunderbird" ||
      system.name == "SeaMonkey" ||
      system.name == "Icedove") {
    let thunderbird = require('./thunderbird.js');
    thunderbird.init();
  } else {
    require("sdk/simple-prefs").on("test", ()=>{
      utils.showGnotifierNotification("This works only in Thunderbird!");
    });
  }
};

exports.onUnload = (reason)=>{
  deleteTempFiles();

  if (!notifApi) {
    return;
  }

  notifApi.deInit();
  notifApi = null;

  // Unregister current alerts-service class factory
  const contract = "@mozilla.org/alerts-service;1";
  let registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
  registrar.unregisterFactory(
    Cc[contract],
    Cm.getClassObject(Cc[contract], Ci.nsIFactory)
  );

  // Register orig alert service factory
  registrar.registerFactory(
    Cc[contract],
    "Orig Alerts Service",
    contract,
    origAlertsServiceFactory
  );

  // Works only in FF<26
  try {
    let ps = require("sdk/preferences/service");
    ps.set("browser.download.manager.showAlertOnComplete", true);
  } catch(e) {}

  // Thunderbird deinit
  if (system.name == "Thunderbird" ||
      system.name == "SeaMonkey" ||
      system.name == "Icedove") {
    let thunderbird = require("./thunderbird.js");
    thunderbird.deInit();
  }
}
