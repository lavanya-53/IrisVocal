package com.irisvocal.irisvocal_backend.Service;

import com.irisvocal.irisvocal_backend.Dto.EmergencyRequest;
import com.irisvocal.irisvocal_backend.Dto.EmergencyResponse;
import com.irisvocal.irisvocal_backend.Enums.EmergencyStatus;
import com.irisvocal.irisvocal_backend.Model.User;
import com.twilio.exception.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class EmergencyService {
    private final UserService userService;
    private final TwilioSmsService twilioSmsService;

    public EmergencyService(
            UserService userService,
            TwilioSmsService twilioSmsService) {

        this.userService = userService;
        this.twilioSmsService = twilioSmsService;
    }
    public EmergencyResponse SendEmergencyAlert(EmergencyRequest request,String email)
    {
        User user=userService.findUserByEmail(email);
        String ContactNumber=user.getEmergencyContactNumber();
        if (ContactNumber == null || ContactNumber.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "Emergency contact number is not configured"
            );
        }
        double latitude= request.getLatitude();
        double longitude=request.getLongitude();
        String locationUrl="https://maps.google.com/?q="+latitude+","+longitude;
        String smsBody=request.getMessage()
            + "\nMy current location: "
            + locationUrl;

        try {
            twilioSmsService.sendSms(ContactNumber, smsBody);

            // Reached here if the SMS request was accepted by Twilio
            return new EmergencyResponse(
                    true,
                    EmergencyStatus.ALERT_ACCEPTED,
                    "Emergency SMS request accepted by Twilio.",
                    locationUrl
            );

        } catch (ApiException ex) {

            // Twilio returned an API error
            throw new ResponseStatusException(
                    HttpStatus.BAD_GATEWAY,
                    "Failed to submit emergency SMS request."
            );

        } catch (Exception ex) {

            // Handle other unexpected errors
            throw new ResponseStatusException(
                    HttpStatus.INTERNAL_SERVER_ERROR,
                    "An unexpected error occurred while processing the emergency alert."
            );
        }
    }
    }

