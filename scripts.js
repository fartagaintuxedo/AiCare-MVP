/*TO-DO
- Mark beginning of trip with a marker
- Terminate session if mqtt session ends (cant connect anymore) or somehow spot windows sleep or something because when windows sleeps timers dont work
- We need to better handle connection errors (some very few times - especially after a windows hypbernation - there are uncaught connection erors)
- Hide scripts.js file in password protected folder
- Zero down accelerations when car is not moving
- Subscribe to collisions and unplug detection
- Very important to track offline periods for each device and display an "underground parking" notice/warning
- Communicate session termination to user (could be a window alert) /session ended due to inactivity
- Check if debounce should be present
- Warning for offline status / mention possibility of underground parking?
- If user not registered display message
- Get violation limits from backend
- Show vehicle idle or moving in the dashboard
- "Time" as in the ddashboard should be time of last message or something like that
- Include crash and unplug detection in the dashboard
- To be completely accurate, violation markers should not just take the last lat lon position but they should go in between timestamps ... but then how do we know in which order they are recieved.. maybe from the complete message... this is imoprtant it has to be solved
- When 2 events happen in a same location, the popup attached to the circle should contain all events
- *For teltonika --> ask why inconsistent acc values vs harsh events
- Add a support contact form or something in case users have tech problems


--
Done
-- Mark violation events with circles
-- Show names of policy holders and number plates side by side in the drop-down menu
-- Logout after 30 min or 1 h idle or window not active
-- If only 1 vehicle load it automatically
-- In ACL token we need to pass the specific list of vehicles that require permission
-- Update vehicle and driver name information on the dashboard
-- Replace 'Demo Dashboard' with user name

--
Bugs
- When computer sleeps before session timeout it comes back at the sleep/hibernate time and doesnt update to current time

*/

const acc_limit = 2.5/10.0;
const bra_limit = 2.7/10.0;
const cor_limit = 3.4/10.0;
const speed_limit = 120;

var map;
var marker;
var polyline;
var circles_layergroup = L.layerGroup([]);

var messages = [];
var user_data;

var devicesList = {};
var telemetry = [];
var mapready = false;
var login = null;
var client;
var session_idle_time = 0;
var clock;
var idleSecondsCounter = 0;
//access Flespi API to generate ACL token
//type 2 is ACL


//874829 // Matthew Halkin car
//866121 // Jaime car
//831573 // Arthur old car
//874813 //Uber Michael car
async function getACL(){
	var flespi_ids = [];
	for(nplate of Object.keys(user_data["number_plates"])){
		flespi_ids.push(user_data["number_plates"][nplate]["flespi_id"]);
	}
	console.log("flespi_ids.toString() --> " + flespi_ids.toString());
	const data = '[{"access":{"acl":[{"methods":["GET"],"submodules":[{"methods":["GET"],"name":"telemetry"}],"uri":"gw/devices","ids":[' + flespi_ids.toString() + ']}],"type":2},"info":"user-acl-dashboard","ttl":600}]';
	const messages_request_url = "https://flespi.io/platform/customer/tokens" + "?data=" + encodeURIComponent(data);
	const mydata = {'headers': {'Authorization': 'FlespiToken lQFuoxxxxxxxxxxxxxxx2wDpKyXD'}, 'method': 'POST', 'fields':['id','key']};
	const response = await fetch(messages_request_url, mydata);
	const json_resp = await response.json();
	console.log(json_resp);
	//console.log(json_resp['result'][0]['key']);
	return json_resp['result'][0]['key'];
}


// mqtt processing function
async function main (flespi_id, nplate, driver_full_name) {
    const mqtt_token = await getACL();
	
    if (client && client.end) { client.end()}
    //console.log('token=' + mqtt_token);
    client = mqtt.connect('wss://mqtt.flespi.io', {
	username: mqtt_token,
	clientId: 'aicare_mqtt_client_' + Math.random().toString(16).substr(2, 8),
	protocolVersion: 5,
	clean: true,
	wsOptions: {
	    objectMode: false,
	    perMessageDeflate: true
	},
	resubscribe: false,
	keepalive: 60
    });
    client.on('error', function (err) {
	console.log(err);
	console.log('there was an error when logging into mqtt');
	client.end();
    });
    // on connect - clear lists and subscribe
    client.on('connect', function () {
	devicesList = {};
	telemetry = [];
	
	//initialize a new polyline
	init_polyline(map, polyline);
		
	console.log('client connected');
	console.log('flespi_id length:' +  flespi_id.length);
		
	// subscribe to device list
	client.subscribe('flespi/state/gw/devices/' + flespi_id + '/telemetry/timestamp,position,x.acceleration,y.acceleration,z.acceleration,crash.event', { qos: 0 },
		function (err, granted){console.log(err);console.log(granted);});	
	//client.subscribe('flespi/state/gw/devices/+', { qos: 0 });
	
	var timestamp, vel, acc, bra, cor, lat, lon;
		
	// message processing
	client.on('message', function (topic, message, packet) {
		console.log('message:= ' + message.toString() + '\ntopic:= ' + topic + '\npacket:= ' + packet);
		var arr_topic = topic.split('/');
		var topic = arr_topic[arr_topic.length - 1];
		
		//var timestamp, vel, acc, bra, cor, lat, lon;//we moved this 1 level up
		
		const time_div = document.getElementById("timestamp");
		const vel_div = document.getElementById("vel");
		const acc_div = document.getElementById("acc");
		const bra_div = document.getElementById("bra");
		const cor_div = document.getElementById("cor");
		const lon_div = document.getElementById("lon");
		const lat_div = document.getElementById("lat");
		
		switch(topic) {
			case 'timestamp':
				timestamp = message;
				time_div.innerHTML = new Date(Number(timestamp*1000)); // remember js works with miliseconds...
				telemetry.push({"timestamp": timestamp});
			break;
			case 'x.acceleration':
				var acc_or_bra = parseFloat(message);
				if(acc_or_bra > 0){
					acc = 0;
					bra = parseFloat(message);
					draw_violation_mark("Braking", bra, lat, lon, bra_limit);
				}else{
					bra = 0;
					acc = Math.abs(parseFloat(message)); // we dont want to show negative values on the dashboard
					draw_violation_mark("Acceleration", acc, lat, lon, acc_limit);
				}
				acc_div.innerHTML = (10*acc).toFixed(2);
				bra_div.innerHTML = (10*bra).toFixed(2);
				telemetry.push({"x.acceleration": message});
			break;
			case 'y.acceleration':
				cor = parseFloat(message);
				cor_div.innerHTML = (10*cor).toFixed(2);
				telemetry.push({"y.acceleration": message});
				draw_violation_mark("Cornering", cor, lat, lon, cor_limit);
				
			break;
			case 'position':
				pos_msg = JSON.parse(message)
				
				vel = pos_msg["speed"];
				vel = parseFloat(vel);
				vel_div.innerHTML = vel.toFixed(1);
				telemetry.push({"position.speed": pos_msg["speed"]});
				draw_violation_mark("Speed", vel, lat, lon, speed_limit);
				
				lon = pos_msg['longitude'];
				lon_div.innerHTML = lon;
				telemetry.push({"position.longitude": pos_msg['longitude']});
				
				lat = pos_msg['latitude'];
				lat_div.innerHTML = lat;
				telemetry.push({"position.latitude": pos_msg['latitude']});
				
				var newLatLng = new L.LatLng(lat, lon);
				polyline.addLatLng(newLatLng);
				/*
				//center the vehicle only when selecting it
				if(polyline.getLatLngs().length == 1){
					
					if(marker){
						map.removeLayer(marker);
					}
					marker = L.marker(newLatLng).addTo(map)
						.bindPopup(driver_full_name + "<br>" + nplate)
						.openPopup();
				}else if(polyline.getLatLngs().length > 1){
					marker.setLatLng(newLatLng);
				}*/
			break;
			
			//default:
				// code block
			
		}
		
		/*marker, polyline and view*/
		var polypoints = polyline.getLatLngs();
		console.log("length="+polypoints.length);
		
		if(polypoints.length == 1){
			
			console.log("getlatlon: " + polypoints[0]);
			//center the vehicle only when selecting it
			
			//setView is acting funny for some strange reason, flyTo seems to work fine... 
			//setview was working nicely when there was no more code below.. the marker stuff was below polyline.addLatLng(newLatLng);
			//actually fly-to im not sure it works perfectly either, it fails to sharpen thee image upon arrival to destination?
			map.flyTo(polypoints[0]);
			//map.setView(polypoints[0], 13);
			
			if(marker){
				map.removeLayer(marker);
			}
			marker = L.marker(polypoints[0]).addTo(map)
				.bindPopup(driver_full_name + "<br>" + nplate)
				.openPopup();
		}else if(polyline.getLatLngs().length > 1){
			marker.setLatLng(polypoints[polypoints.length - 1]);
		}
		
		/*telemetry section*/
		const telemetry_stream = document.getElementById("msg");
		var str_tel = "";
		for(const elem of telemetry){
			str_tel += Object.keys(elem)[0] + ": " + Object.values(elem)[0] + ", ";
		}
			
		telemetry_stream.innerHTML = str_tel;
		
		while(telemetry.length > 100){
			/*console.log(messages.length);*/
			telemetry.shift();//remove first element from array
		} 
	});
    });
}


//load user data ////driving scores from backend
function loadUserData(user){
	console.log(user.email);
	
	var imei = "";
	
	fetch('scores/identities.json')
		.then((resp) => resp.json()) // Transform the data into json
		.then(function(data) {
			user_data = data["users"][user.email];
			console.log(Object.keys(user_data["number_plates"]));
			
			var user_name  = user_data["name"] + " " + user_data["surname"];
			document.getElementById("welcome_div").innerHTML = user_name;
			
			var cust_dropdown = document.getElementById("cust-search-dropdown");
			dropdown_content = "";
			
			var nplate_keys_list = Object.keys(user_data["number_plates"]);
			
			// Populate drop-down menu
			for(nplate of nplate_keys_list){
				var full_name = get_full_name_by_nplate(nplate);
				dropdown_content += "<div class=\"cust-dropdown-items\"><a href=\"#\" id=\"" + nplate + "\" class=\"number-plate-links\">" + nplate + " " + full_name + "</a></div>";
			}

			// If user has only 1 vehicle then pre-load it
			if(nplate_keys_list.length == 1){
				select_customer_express(nplate_keys_list[0]);
			}
				
			cust_dropdown.innerHTML = dropdown_content;
			addListeners();
		}
	);
}

function get_full_name_by_nplate(nplate){
	var given_name = user_data["number_plates"][nplate]["policy_holder_given_name"];
	var family_name = user_data["number_plates"][nplate]["policy_holder_family_name"];
	
	return given_name + " " + family_name;
}

function draw_violation_mark(event_type, value, lat, lon, limit){
	if(lat && lon && Math.abs(value) > limit){
		var circle = L.circle([lat, lon], {
			radius: 12,
			stroke: false,
			fillColor: 'red',
			fillOpacity: 0.8
		}); 
		
		var popup = L.popup({}, circle);
		if(event_type == "Speed"){
			popup.setContent(event_type + " violation<br>" + "Value: " + value + " km/h<br>Limit: " + limit + " km/h");
		}else{
			popup.setContent(event_type + " violation<br>" + "Value: " + Math.abs(10*value).toFixed(2) + " m/s2<br>Limit: " + (10*limit).toFixed(2) + " m/s2");
		}
		popup.setLatLng([lat, lon]); // This should work but it doesn't do anything, see --> https://stackoverflow.com/questions/62468493/how-to-set-a-specific-position-for-a-leaflet-popup 
		circle.bindPopup(popup);
		// Thus we need to include this work-around...
		circles_layergroup.addLayer(circle).addTo(map);
		circle.on('click', function(ev) { 
			ev.target.openPopup(ev.target.getLatLng()) 
		});
	}
}

// This initializes a new polyline but also violation marks .. maybe the naming should be more accurate
function init_polyline(){
	if(polyline){
		map.removeLayer(polyline);
	}
	
	if(circles_layergroup){
		circles_layergroup.clearLayers();
	}
	
	polyline = new L.Polyline([], {
	    color: 'red',
	    weight: 3,
	    opacity: 0.8,
	    smoothFactor: 2
	});
	polyline.addTo(map);
}

// I´m not really sure when i should use async / await ... This needs to be revised
async function fetch_vehicle_data(imei){
	await fetch('scores/' + imei + '.json', {cache: "reload"})
		  .then((resp) => resp.json()) // Transform the data into json
		  .then(function(data) {
			//score values:
			//359632103503303 mathew halkin car
			//359632107442045 arthur old car
			//359633105532589 jaime car

			//const api_request = await fetch('https://417i.com/aicare/scores/359632103503303.json');
			//const scores_json = await response.json(); //extract JSON from the http response
			var scores_json = data;
			console.log(scores_json);
			var global_score = scores_json['global-score'];
			var acc_score = scores_json['acc_scores']['score-data']['total-score'];
			var acc_median_val = scores_json['acc_scores']['score-data']['median-value']
			var acc_median_speed = scores_json['acc_scores']['score-data']['median-speed']
			var acc_total_events = scores_json['acc_scores']['score-data']['total-events']
			var acc_events_day = scores_json['acc_scores']['score-data']['events/day']
			
			var braking_score = scores_json['braking_scores']['score-data']['total-score'];
			var braking_median_val = scores_json['braking_scores']['score-data']['median-value']
			var braking_median_speed = scores_json['braking_scores']['score-data']['median-speed']
			var braking_total_events = scores_json['braking_scores']['score-data']['total-events']
			var braking_events_day = scores_json['braking_scores']['score-data']['events/day']
			
			var cornering_score = scores_json['cornering_scores']['score-data']['total-score'];
			var cornering_median_val = scores_json['cornering_scores']['score-data']['median-value']
			var cornering_median_speed = scores_json['cornering_scores']['score-data']['median-speed']
			var cornering_total_events = scores_json['cornering_scores']['score-data']['total-events']
			var cornering_events_day = scores_json['cornering_scores']['score-data']['events/day']
			
			var bump_score = scores_json['bump_scores']['score-data']['total-score'];
			
			var pacing_score = scores_json['pacing_scores']['score'];
			var pacing_avg = scores_json['pacing_scores']['avg-trip-pace'];
			var pacing_max = scores_json['pacing_scores']['max-trip-pace'];
			
			var overspeed_score = scores_json['overspeed_scores']['score'];
			var overspeed_time = scores_json['overspeed_scores']['recurr_duration'];
			if (typeof overspeed_time === 'undefined'){
				overspeed_time = 0;
			}
			
			var overspeed_mean = scores_json['overspeed_scores']['mean_speed'];
			if (typeof overspeed_mean === 'undefined'){
				overspeed_mean = 'NaN';
			}else{
				overspeed_mean = overspeed_mean.toFixed(2);
			}
			
			var overspeed_fatigue = scores_json['overspeed_scores']['recurr_fatigue'];
			
			var fatigue_score = scores_json['fatigue_scores']['score'];
			var ntrips = scores_json['trip-data']['n_trips']
			var driving_time = scores_json['trip-data']['total_driving_time']
			
			
			const global_score_div = document.getElementById("global-score");
			global_score_div.innerHTML = global_score.toFixed(1);
			  
			const acc_score_div = document.getElementById("acc-score");
			acc_score_div.innerHTML = (100-acc_score).toFixed(1);

			const bra_score_div = document.getElementById("bra-score");
			bra_score_div.innerHTML = (100-braking_score).toFixed(1);

			const cor_score_div = document.getElementById("cor-score");
			cor_score_div.innerHTML = (100-cornering_score).toFixed(1);

			//const bum_score_div = document.getElementById("bum-score");
			//bum_score_div.innerHTML = (100-bump_score).toFixed(1);

			const vel_score_div = document.getElementById("vel-score");
			vel_score_div.innerHTML = (100-overspeed_score).toFixed(1);
			
			//careful! added arbitrary 30 points to pacing value for temporary adjustment
			const pac_score_div = document.getElementById("pac-score");
			pac_score_div.innerHTML = (100-pacing_score+30).toFixed(1);

			const fat_score_div = document.getElementById("fat-score");
			fat_score_div.innerHTML = (fatigue_score).toFixed(1);
			
			const ntrips_div = document.getElementById("ntrips");
			ntrips_div.innerHTML = (ntrips).toFixed(0);
			
			const uptime_div = document.getElementById("driving-time");
			uptime_div.innerHTML = (driving_time/3600).toFixed(1) + ' h';
			
			/*accleration meta*/
			const med_acc_div = document.getElementById("med-acc");
			med_acc_div.innerHTML = (acc_median_val).toFixed(2) + ' m/s2';
			
			const acc_med_speed_div = document.getElementById("acc-med-speed");
			acc_med_speed_div.innerHTML = (acc_median_speed).toFixed(1) + ' km/h';
			
			const acc_total_events_div = document.getElementById("acc-total-events");
			acc_total_events_div.innerHTML = (acc_total_events).toFixed(0);
			
			const acc_daily_events_div = document.getElementById("acc-daily-events");
			acc_daily_events_div.innerHTML = (acc_events_day).toFixed(1);
			
			/*braking meta*/
			const med_bra_div = document.getElementById("med-bra");
			med_bra_div.innerHTML = (braking_median_val).toFixed(2) + ' m/s2';
			
			const bra_med_speed_div = document.getElementById("bra-med-speed");
			bra_med_speed_div.innerHTML = (braking_median_speed).toFixed(1) + ' km/h';
			
			const bra_total_events_div = document.getElementById("bra-total-events");
			bra_total_events_div.innerHTML = (braking_total_events).toFixed(0);
			
			const bra_daily_events_div = document.getElementById("bra-daily-events");
			bra_daily_events_div.innerHTML = (braking_events_day).toFixed(1);
			
			/*cornering meta*/
			const med_cor_div = document.getElementById("med-cor");
			med_cor_div.innerHTML = (cornering_median_val).toFixed(2) + ' m/s2';
			
			const cor_med_speed_div = document.getElementById("cor-med-speed");
			cor_med_speed_div.innerHTML = (cornering_median_speed).toFixed(1) + ' km/h';
			
			const cor_total_events_div = document.getElementById("cor-total-events");
			cor_total_events_div.innerHTML = (cornering_total_events).toFixed(0);
			
			const cor_daily_events_div = document.getElementById("cor-daily-events");
			cor_daily_events_div.innerHTML = (cornering_events_day).toFixed(1);
			
			/*overspeed meta*/
			const ospeed_time_div = document.getElementById("ospeed_time");
			ospeed_time_div.innerHTML = (overspeed_time/60).toFixed(4) + ' min/day';
			
			const ospeed_mean_div = document.getElementById("ospeed_mean");
			ospeed_mean_div.innerHTML = (overspeed_mean) + ' km/h';
			
			const ospeed_fatigue_div = document.getElementById("ospeed_fatigue");
			ospeed_fatigue_div.innerHTML = (overspeed_fatigue/60) + ' min/day';
			
			/*pacing meta*/
			const pacing_avg_div = document.getElementById("pacing_avg");
			pacing_avg_div.innerHTML = (pacing_avg).toFixed(1);
			
			const pacing_max_div = document.getElementById("pacing_max");
			pacing_max_div.innerHTML = (pacing_max).toFixed(1);
		}
	);
}

// Add listeners
function addListeners(){
	
	const input = document.getElementById("customer-search-box");
	const listItems = document.getElementsByClassName("number-plate-links");

	input.addEventListener("focus", show_dropdown);
	input.addEventListener("blur", hide_dropdown);

	for(const listItem of listItems) {
		listItem.addEventListener("click", select_customer);
	}
	
	// this listener tracks when the browser tab is inactive - to track idle session time and logout if it exceeds a certain limit
	document.addEventListener('visibilitychange', handleVisibilityChange);
}

// Dropdown customer menu
function show_dropdown(event) {
	document.getElementById("cust-search-dropdown").classList.replace("hidden", "show");
}

// Roll up customer menu
function hide_dropdown(event) {
	var list_menu = document.getElementById("cust-search-dropdown");
	console.log(event.relatedTarget?.parentNode.parentNode);
	if(event.relatedTarget?.parentNode.parentNode !== list_menu) {
		list_menu.classList.replace("show", "hidden");
	}
}


function filterFunction() {
  var input, filter, ul, li, a, i;
	input = document.getElementById("customer-search-box");
	filter = input.value.toUpperCase();
	div = document.getElementById("cust-search-dropdown");
	a = div.getElementsByClassName("cust-dropdown-items");
	for (i = 0; i < a.length; i++) {
		txtValue = a[i].textContent || a[i].innerText;
		if (txtValue.toUpperCase().indexOf(filter) > -1) {
			a[i].style.display = "";
		} else {
			a[i].style.display = "none";
		}
	}
}


function select_customer(event){
	var nplate = event.target.getAttribute('id');
	console.log(nplate);
	var vehicle_flespi_id = user_data["number_plates"][nplate]["flespi_id"].trim();
	var device_imei = user_data["number_plates"][nplate]["imei"].trim();
	var driver_name = user_data["number_plates"][nplate]["policy_holder_given_name"];
	var driver_surname = user_data["number_plates"][nplate]["policy_holder_family_name"];
	
	var driver_full_name = driver_name + " " + driver_surname;
	var vehicle_model = user_data["number_plates"][nplate]["vehicle_model"];
	var date_onboarded = user_data["number_plates"][nplate]["date_onboarded"];
	
	var input = document.getElementById("customer-search-box");
	input.value = nplate;
	
	document.getElementById("policy_holder").innerHTML = driver_full_name;
	document.getElementById("vehicle_make").innerHTML = vehicle_model;
	document.getElementById("date_onboarded").innerHTML = date_onboarded;
	
	console.log('entering main() with flespi id: ' + vehicle_flespi_id);
	main(vehicle_flespi_id, nplate, driver_full_name);
	
	// Hide dropdown after click
	document.getElementById("cust-search-dropdown").classList.replace("show", "hidden");
	
	//Load scores
	fetch_vehicle_data(device_imei);
}


function select_customer_express(nplate){
	
	console.log(nplate);
	var vehicle_flespi_id = user_data["number_plates"][nplate]["flespi_id"].trim();
	var device_imei = user_data["number_plates"][nplate]["imei"].trim();
	var driver_name = user_data["number_plates"][nplate]["policy_holder_given_name"];
	var driver_surname = user_data["number_plates"][nplate]["policy_holder_family_name"];
	
	var driver_full_name = driver_name + " " + driver_surname;
	var vehicle_model = user_data["number_plates"][nplate]["vehicle_model"];
	var date_onboarded = user_data["number_plates"][nplate]["date_onboarded"];
	
	var input = document.getElementById("customer-search-box");
	input.value = nplate;
	
	document.getElementById("policy_holder").innerHTML = driver_full_name;
	document.getElementById("vehicle_make").innerHTML = vehicle_model;
	document.getElementById("date_onboarded").innerHTML = date_onboarded;
	
	console.log('entering main() with flespi id: ' + vehicle_flespi_id);
	main(vehicle_flespi_id, nplate, driver_full_name);
	
	// Hide dropdown after click
	document.getElementById("cust-search-dropdown").classList.replace("show", "hidden");
	
	//Load scores
	fetch_vehicle_data(device_imei);
}


function handleVisibilityChange(){
	console.log("//////////////////////////////// visibility changed ////////////////////////////");
	if (document.visibilityState == "hidden") {
		clock= setInterval(timer, 1000);
	}else{
		window.clearInterval(clock);
		session_idle_time = 0;
	}
}

function timer(){
	session_idle_time++; //seconds
	if(session_idle_time % 60 == 0){
		console.log("tab_not_active_time: " + session_idle_time/60 + " min");
	}
	
	if(session_idle_time > 60*60){
		console.log("session expired");
		auth.signOut();
		//TODO communicate to user
	}
}

// Check idle time
document.onmousemove = function () {
	idleMinutesCounter = 0;
};

function CheckIdleTime(){
	idleMinutesCounter++;
	if(idleMinutesCounter > 60){
		console.log("session expired");
		auth.signOut();
		//TODO communicate to user
	}
}














