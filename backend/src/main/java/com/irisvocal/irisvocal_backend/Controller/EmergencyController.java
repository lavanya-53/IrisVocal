package com.irisvocal.irisvocal_backend.Controller;

import com.irisvocal.irisvocal_backend.Dto.EmergencyRequest;
import com.irisvocal.irisvocal_backend.Dto.EmergencyResponse;
import com.irisvocal.irisvocal_backend.Service.EmergencyService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

//if u r building rest api that returns json to react then us this
@RestController
@RequestMapping("/api/emergency")
public class EmergencyController {
    public  final EmergencyService emergencyService;
   public EmergencyController(EmergencyService emergencyService){
       this.emergencyService=emergencyService;
   }
    @PostMapping
    //@Valid tells Spring Boot to check whether the incoming request data follows the validation rules defined in EmergencyRequest.java.
    //@RequestBody receives and converts the data; @Valid checks whether that data is valid.
    public ResponseEntity<EmergencyResponse>SendEmergencyAlert(@Valid @RequestBody EmergencyRequest request, Authentication authentication){
       String email= authentication.getName();;
        EmergencyResponse resp=emergencyService.sendEmergencyAlert(request, email);
        return ResponseEntity.ok(resp);
    }
}
